"""Exercise deployed HTTPS API and stateless MCP using isolated QA accounts.

Credentials are generated in memory and never printed. No existing workspace
is modified. The two verification accounts remain as deployment QA fixtures;
their sessions are logged out and their integration token is revoked.
"""
import argparse
import json
import pathlib
import secrets
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check_login(base):
    base = base.rstrip('/')
    assert base.startswith('https://')
    email = f'deploy-login-{uuid.uuid4().hex}@example.test'
    password = secrets.token_urlsafe(32)

    def call(path, data=None, cookie=''):
        headers = {'Content-Type': 'application/json', 'Origin': base}
        if cookie:
            headers['Cookie'] = cookie
        req = urllib.request.Request(base + '/api/v1/' + path,
            data=json.dumps(data).encode() if data is not None else None, headers=headers)
        with urllib.request.urlopen(req, timeout=40) as response:
            return response.status, response.headers, json.loads(response.read())

    _, headers, _ = call('auth/register', {'email': email, 'password': password})
    initial = headers.get('Set-Cookie', '').split(';')[0]
    call('auth/logout', {}, initial)
    status, headers, _ = call('auth/login', {'email': email, 'password': password})
    assert status == 200 and all(x in headers.get('Set-Cookie', '') for x in ('Secure', 'HttpOnly', 'SameSite=Strict'))
    session = headers.get('Set-Cookie', '').split(';')[0]
    try:
        assert call('workspace', cookie=session)[0] == 200
    finally:
        call('auth/logout', {}, session)
    output = pathlib.Path(__file__).resolve().parent.parent / 'output'
    output.mkdir(exist_ok=True)
    (output / ('login-check-' + urllib.parse.urlsplit(base).hostname + '.json')).write_text(json.dumps({
        'url': base, 'passed': True, 'qaAccount': email, 'sessionsLoggedOut': True,
    }, indent=2))
    print('PASS:', base, 'register, logout, fresh login, secure session, authenticated workspace and logout.')


def run(base):
    base = base.rstrip('/')
    assert base.startswith('https://')
    prefix = base + '/api/v1/'

    def request(path, body=None, cookie='', extra=None, method=None):
        headers = {'Origin': base, 'Content-Type': 'application/json', **(extra or {})}
        if cookie:
            headers['Cookie'] = cookie
        req = urllib.request.Request(prefix + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers, method=method or ('POST' if body is not None else 'GET'))
        try:
            response = urllib.request.urlopen(req, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            data = json.loads(raw) if raw else None
            return response.status, response.headers, data

    test_id = uuid.uuid4().hex
    sessions = []
    credential_id = None
    try:
        status, headers, data = request('health')
        assert status == 200 and data['ok'] and 'no-store' in headers.get('Cache-Control', '')
        assert request('workspace')[0] == 401
        for suffix in ('a', 'b'):
            status, headers, data = request('auth/register', {
                'email': f'deploy-{test_id}-{suffix}@example.test',
                'password': secrets.token_urlsafe(32),
            })
            assert status == 200, ('register', status)
            session = headers.get('Set-Cookie', '')
            assert all(flag in session for flag in ('HttpOnly', 'Secure', 'SameSite=Strict'))
            sessions.append(session.split(';')[0])
        owner, other = sessions
        headers = {'If-Match': '"0"', 'Idempotency-Key': uuid.uuid4().hex}
        body = {'name': 'Deployment verification', 'prefix': 'QA'}
        status, _, project = request('commands/project.create', body, owner, headers)
        assert status == 200
        project_id = project['result']['id']
        assert request('commands/project.create', body, owner, headers)[2]['result']['id'] == project_id
        assert request('commands/project.create', body, owner, {**headers, 'Origin': 'https://evil.test'})[0] == 403
        assert request('workspace', cookie=other)[2]['projects'] == []
        assert request('openapi.json')[0] == 200
        assert request('not-a-route', cookie=owner)[0] == 404
        status, _, credential = request('integrations/credentials', {
            'name': 'Deployment MCP verification',
            'permissions': ['projects:read', 'tasks:read', 'tasks:write'], 'expiresInDays': 1,
        }, owner)
        assert status == 201
        credential_id = credential['credential']['id']
        mcp_headers = {'Accept': 'application/json, text/event-stream', 'Authorization': 'Bearer ' + credential['token']}
        rpc_id = 0

        def rpc(method, params=None, extra=None):
            nonlocal rpc_id
            rpc_id += 1
            return request('mcp', {'jsonrpc': '2.0', 'id': rpc_id, 'method': method,
                'params': params or {}}, extra=extra or mcp_headers)

        status, headers, initialized = rpc('initialize', {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'learnverse-deployment-check', 'version': '1.0.0'},
        })
        assert status == 200 and 'application/json' in headers.get('Content-Type', '')
        assert initialized['result']['serverInfo']['name'] == 'learnverse-tasks'
        assert request('mcp', {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, extra=mcp_headers)[0] == 202
        assert len(rpc('tools/list')[2]['result']['tools']) == 11
        projects = rpc('tools/call', {'name': 'list_projects', 'arguments': {}})[2]
        assert json.loads(projects['result']['content'][0]['text'])['items'][0]['id'] == project_id
        task = rpc('tools/call', {'name': 'create_task', 'arguments': {
            'input': {'projectId': project_id, 'title': 'MCP deployment verification', 'type': 'task'},
            'revision': 1, 'idempotencyKey': uuid.uuid4().hex,
        }})[2]
        assert not task['result'].get('isError')
        created_task = json.loads(task['result']['content'][0]['text'])
        assert created_task['revision'] == 2
        revision = 2

        def command(action, value):
            nonlocal revision
            status, _, result = request('commands/' + action, value, owner, {
                'If-Match': f'"{revision}"', 'Idempotency-Key': uuid.uuid4().hex,
            })
            assert status == 200, (action, status)
            revision = result['revision']
            return result['result']

        first = command('sprint.create', {'projectId': project_id, 'name': 'Verification sprint',
            'startDate': '2026-10-07', 'endDate': '2026-10-14'})
        following = command('sprint.create', {'projectId': project_id, 'name': 'Verification carryover',
            'startDate': '2026-10-15', 'endDate': '2026-10-21'})
        command('task.update', {'id': created_task['result']['id'], 'sprintId': first['id']})
        command('sprint.start', {'id': first['id']})
        assert request('commands/sprint.start', {'id': following['id']}, owner, {
            'If-Match': f'"{revision}"', 'Idempotency-Key': uuid.uuid4().hex,
        })[0] == 422
        completed = command('sprint.complete', {'id': first['id'], 'targetSprintId': following['id']})
        assert completed['state'] == 'completed'
        workspace = request('workspace', cookie=owner)[2]
        assert workspace['revision'] == revision
        assert workspace['tasks'][0]['sprintId'] == following['id']
        assert len(completed['snapshot']['unfinished']) == 1
        assert rpc('tools/call', {'name': 'list_sprints', 'arguments': {}})[2]['result']['isError']
        assert rpc('tools/list', extra={**mcp_headers, 'Authorization': 'Bearer invalid'})[0] == 401
        assert request('mcp', extra={'Origin': 'https://evil.test'})[0] == 403
        assert request('mcp', extra=mcp_headers)[0] == 405
        assert request('integrations/credentials/' + credential_id, cookie=owner, method='DELETE')[0] == 200
        credential_id = None
        assert rpc('tools/list')[0] == 401
        for session in sessions:
            assert request('auth/logout', {}, session)[0] == 200
            assert request('workspace', cookie=session)[0] == 401
        sessions.clear()
        record_dir = pathlib.Path(__file__).resolve().parent.parent / 'output'
        record_dir.mkdir(exist_ok=True)
        (record_dir / ('live-check-' + urllib.parse.urlsplit(base).hostname + '.json')).write_text(json.dumps({
            'url': base, 'passed': True, 'qaAccounts': [f'deploy-{test_id}-{suffix}@example.test' for suffix in ('a', 'b')],
            'sessionsLoggedOut': True, 'integrationTokenRevoked': True,
            'checks': ['health', 'secure sessions', 'isolation', 'retries', 'origin', 'sprint lifecycle and carryover',
                       'OpenAPI', 'MCP initialize/list/read/write/permission/revocation', 'logout'],
        }, indent=2))
        print('PASS:', base, 'DB health; secure sessions; isolation; retries; origin protection; sprint lifecycle and carryover; OpenAPI; MCP initialize, 11 tools, read/write, scope denial, invalid token, revocation and logout.')
    finally:
        if credential_id and sessions:
            request('integrations/credentials/' + credential_id, cookie=sessions[0], method='DELETE')
        for session in sessions:
            request('auth/logout', {}, session)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--login-only', action='store_true')
    args = parser.parse_args()
    (check_login if args.login_only else run)(args.url)
