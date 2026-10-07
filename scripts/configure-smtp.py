"""Read the explicitly supplied Gmail credential file, store encrypted, erase input.

No password value appears in command arguments, release artifacts or output.
Run in the authenticated CloudShell with the owner's supplied private input file.
"""
import importlib.util
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', root / 'scripts/aws-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.REGION = 'ap-south-1'
path = pathlib.Path(sys.argv[1]).resolve()
try:
    value = json.loads(path.read_text())
    assert value['user'] == 'learnverse02@gmail.com'
    assert isinstance(value['password'], str) and len(value['password']) == 16 and value['password'].isalpha()
    assert release.aws('sts', 'get-caller-identity')['Account'] == '061525403372'
    for environment in ('dev', 'prod'):
        name = '/learnverse-tasks/' + environment + '/smtp'
        result = release.aws('ssm', 'put-parameter', Name=name, Type='SecureString', Tier='Standard',
            Description='LearnVerse Tasks owner-authorized Gmail SMTP app credential', Value=json.dumps(value), Overwrite=True)
        print(environment, 'encrypted SMTP parameter saved; version', result['Version'], flush=True)
finally:
    path.unlink(missing_ok=True)
