"""Attach the requested production hostname using reviewed CloudFormation stages.

Run in authenticated CloudShell. Certificates, edge configuration, DNS publication
and canonical activation are separate actions; existing origin secrets stay private.
"""
import argparse
import json
import pathlib
import socket
import time
import urllib.request
import importlib.util

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/aws-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
DOMAIN = 'tasks.abuk.in'
ZONE = 'Z07756052FLIKFJDVDRZW'
ACCOUNT = '061525403372'
PROD = 'learnverse-tasks-prod'

def cli(region):
    release.REGION = region
    release.EXECUTE = True
    assert release.aws('sts', 'get-caller-identity')['Account'] == ACCOUNT

def params(existing, overrides):
    result = [{'ParameterKey': p['ParameterKey'], 'UsePreviousValue': True}
              for p in existing['Parameters'] if p['ParameterKey'] not in overrides]
    return result + [{'ParameterKey': k, 'ParameterValue': v} for k, v in overrides.items()]

def save(name, value):
    (ROOT / 'output').mkdir(exist_ok=True)
    (ROOT / 'output' / name).write_text(json.dumps(value, indent=2) + '\n')

def snapshot():
    path = ROOT / 'output/domain-rollback.json'
    if path.exists():
        return
    existing = release.stack(PROD)
    original = release.aws('cloudformation', 'get-template', StackName=PROD)['TemplateBody']
    if isinstance(original, str):
        original = json.loads(original)
    save('domain-previous-template.json', original)
    records = release.aws('route53', 'list-resource-record-sets', HostedZoneId=ZONE)['ResourceRecordSets']
    owned = [r for r in records if r['Name'] == DOMAIN + '.']
    assert not owned, 'Hostname already exists; inspect ownership before changing DNS.'
    save('domain-rollback.json', {'domain': DOMAIN, 'hostedZoneId': ZONE, 'previousDnsRecords': owned,
        'previousOutputs': release.outputs(existing),
        'previousParameters': {p['ParameterKey']: p['ParameterValue'] for p in existing['Parameters'] if p['ParameterKey'] != 'OriginToken'}})

def certificate():
    cli('us-east-1')
    zone = release.aws('route53', 'get-hosted-zone', Id=ZONE)
    assert zone['HostedZone']['Name'] == 'abuk.in.' and not zone['HostedZone']['Config']['PrivateZone']
    values = release.change('learnverse-tasks-certificate', ROOT / 'infra/aws/certificate.json',
        [{'ParameterKey': 'HostedZoneId', 'ParameterValue': ZONE}])
    cert = release.aws('acm', 'describe-certificate', CertificateArn=values['CertificateArn'])['Certificate']
    assert cert['Status'] == 'ISSUED' and DOMAIN in cert['SubjectAlternativeNames']
    save('domain-certificate.json', {'region':'us-east-1', **values, 'status':cert['Status'], 'domain':DOMAIN})
    print('Certificate issued:', values['CertificateArn'], flush=True)

def configure(stage):
    cli('ap-south-1')
    if stage == 'dev':
        existing = release.stack('learnverse-tasks-dev')
        live = release.change('learnverse-tasks-dev', ROOT / 'infra/aws/environment.json', params(existing, {}))
        release.verify(live['CloudFrontUrl'], live['DistributionId'])
        save('domain-dev-check.json', {'passed':True, **live})
        return
    snapshot()
    existing = release.stack(PROD)
    previous = release.outputs(existing)
    cert = json.loads((ROOT / 'output/domain-certificate.json').read_text())['CertificateArn']
    assert cert.startswith('arn:aws:acm:us-east-1:' + ACCOUNT + ':certificate/')
    records = release.aws('route53','list-resource-record-sets',HostedZoneId=ZONE)['ResourceRecordSets']
    for record in records:
        if record['Name'] == DOMAIN + '.':
            assert record['Type'] in ('A','AAAA') and record.get('AliasTarget',{}).get('DNSName','').rstrip('.') == 'd2e5t8yuyjw8m2.cloudfront.net'
    distribution = release.aws('cloudfront','get-distribution',Id=previous['DistributionId'])['Distribution']
    assert distribution['DistributionConfig']['WebACLId'] == ''
    assert distribution['DistributionConfig']['Aliases'].get('Items',[]) in ([], [DOMAIN])
    override = {'CustomDomainName':DOMAIN, 'ViewerCertificateArn':cert, 'DomainHostedZoneId':ZONE,
        'PublishDomainDns':'false' if stage == 'edge' else 'true',
        'ActivateCustomDomain':'true' if stage == 'activate' else 'false'}
    if stage == 'activate':
        assert any(r['Name'] == DOMAIN + '.' and r['Type'] == 'A' for r in records)
        with urllib.request.urlopen('https://' + DOMAIN + '/api/v1/health',timeout=40) as response:
            assert json.load(response)['ok']
    live = release.change(PROD, ROOT / 'infra/aws/environment.json', params(existing, override))
    distribution = release.aws('cloudfront','get-distribution',Id=live['DistributionId'])['Distribution']
    assert distribution['Status'] == 'Deployed' and distribution['DistributionConfig']['Aliases']['Items'] == [DOMAIN]
    if stage == 'edge':
        release.verify(live['CloudFrontUrl'], live['DistributionId'])
    if stage in ('dns','activate'):
        deadline = time.monotonic() + 180
        while True:
            try:
                addresses = socket.getaddrinfo(DOMAIN,443)
                assert addresses
                with urllib.request.urlopen('https://' + DOMAIN + '/api/v1/health',timeout=40) as response:
                    assert json.load(response)['ok']
                break
            except (OSError, AssertionError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(10)
    if stage == 'activate':
        release.verify('https://' + DOMAIN, live['DistributionId'])
        request = urllib.request.Request(live['CloudFrontUrl'] + '/projects/example?q=a%20b', headers={'Accept':'text/html'})
        with urllib.request.urlopen(request, timeout=40) as response:
            assert response.url == 'https://' + DOMAIN + '/projects/example?q=a%20b'
        save('domain-deployment.json', {'passed':True, 'domain':DOMAIN, 'hostedZoneId':ZONE,
            'certificateArn':cert, 'apiKey':next(p['ParameterValue'] for p in existing['Parameters'] if p['ParameterKey']=='ApiCodeKey'), **live})
    print('Completed domain stage:', stage, flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage',choices=['certificate','dev','edge','dns','activate'])
    args = parser.parse_args()
    if args.stage == 'certificate':
        certificate()
    else:
        configure(args.stage)
