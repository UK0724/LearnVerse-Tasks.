"""Live QA in a new isolated workspace; credentials are held only in memory.

One recovery email is sent to a unique alias of the owner's configured Gmail.
Only a fixed CloudWatch acceptance message is inspected, never mail or credentials.
"""
import argparse
import http.cookiejar
import importlib.util
import json
import pathlib
import secrets
import time
import urllib.error
import urllib.request
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', root / 'scripts/aws-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.REGION = 'ap-south-1'

def check(environment, origin):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    email = 'learnverse02+tasks-' + environment + '-' + uuid.uuid4().hex[:12] + '@gmail.com'
    password, replacement = secrets.token_hex(24), secrets.token_hex(24)
    def request(path, body=None, headers=None, client=opener):
        r = urllib.request.Request(origin + '/api/v1/' + path, data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json', 'Origin':origin, **(headers or {})})
        try:
            with client.open(r, timeout=40) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)
    def command(action, body, revision):
        return request('commands/' + action, body, {'If-Match':'"' + str(revision) + '"', 'Idempotency-Key':str(uuid.uuid4())})
    assert request('auth/register', {'email':email, 'password':password})[0] == 200
    assert request('auth/me')[1]['email'] == email
    code, created = command('project.create', {'name':'Feature verification', 'prefix':'QA'}, 0)
    assert code == 200
    project = created['result']['id']
    payload = {'projectId':project, 'rows':[{'title':'Imported work','type':'task'}, {'title':'imported  work','type':'task'}, {'title':'Another item','type':'bug'}]}
    meta = {'If-Match':'"1"', 'Idempotency-Key':str(uuid.uuid4())}
    code, imported = request('commands/task.import', payload, meta)
    assert code == 200 and imported['result']['created'] == 2 and len(imported['result']['skipped']) == 1
    assert request('commands/task.import', payload, meta)[1] == imported
    before = request('workspace')[1]
    assert command('task.import', {'projectId':project, 'rows':[{'title':'Would be valid','type':'task'}, {'title':'Invalid orphan','type':'subtask'}]}, 2)[0] == 422
    assert request('workspace')[1]['tasks'] == before['tasks']
    link = origin + '/tasks/' + before['tasks'][0]['id']
    with opener.open(urllib.request.Request(link,headers={'Accept':'text/html'}),timeout=40) as response:
        assert response.status == 200 and b'<div id="root"' in response.read()
    code, credential = request('integrations/credentials', {'name':'Password revocation check','permissions':['tasks:read'],'expiresInDays':1})
    assert code == 201
    started = int(time.time() * 1000)
    code, known = request('auth/forgot-password', {'email':email})
    assert code == 200
    code, unknown = request('auth/forgot-password', {'email':'unknown-' + uuid.uuid4().hex + '@example.test'})
    assert code == 200 and unknown == known
    accepted = False
    for _ in range(12):
        events = release.aws('logs','filter-log-events',logGroupName='/aws/lambda/learnverse-tasks-' + environment + '-api', startTime=started, filterPattern='"Password reset email accepted"')['events']
        if events: accepted = True; break
        time.sleep(5)
    assert accepted, 'No reset SMTP acceptance observed; inspect fixed delivery diagnostics.'
    assert request('auth/reset-password', {'token':'a'*64,'password':replacement})[0] == 422
    assert request('auth/change-password', {'currentPassword':password,'password':replacement})[0] == 200
    assert request('workspace')[0] == 401
    anonymous = urllib.request.build_opener()
    assert request('integrations/tasks',headers={'Authorization':'Bearer ' + credential['token']},client=anonymous)[0] == 401
    assert request('auth/login', {'email':email,'password':password})[0] == 401
    assert request('auth/login', {'email':email,'password':replacement})[0] == 200
    assert request('workspace')[1]['tasks'] == before['tasks']
    assert request('auth/logout', {})[0] == 200
    record = {'passed':True,'environment':environment,'website':origin,'qaEmail':email,
        'checks':['account email','bulk import duplicates','import retry','atomic rejected import','task deep link','Gmail SMTP accepted reset email','non-enumerating recovery response','invalid reset token rejected','password change','session and integration credential invalidation','old password rejected','fresh login','workspace persistence','logout'],
        'resetSecurity':'Expiry, single-use and simultaneous reset requests verified by local Mongo-backed tests using the same deployed source.',
        'residualData':'This isolated QA account/project and imported tasks remain; sessions and credentials are invalidated. Gmail inbox placement was not inspected.'}
    (root / 'output').mkdir(exist_ok=True)
    (root / 'output' / ('feature-check-' + environment + '.json')).write_text(json.dumps(record,indent=2)+'\n')
    print('PASS:', environment, 'feature checks, Gmail reset SMTP acceptance, auth invalidation and persistence.',flush=True)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('environment',choices=['dev','prod'])
    args=parser.parse_args()
    assert release.aws('sts','get-caller-identity')['Account'] == '061525403372'
    check(args.environment, 'https://d38hszs898xc3y.cloudfront.net' if args.environment == 'dev' else 'https://tasks.abuk.in')
