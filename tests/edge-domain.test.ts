import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = JSON.parse(readFileSync('infra/aws/environment.json', 'utf8'));
function handler(domain: string) {
  const code = template.Resources.SpaRewrite.Properties.FunctionCode['Fn::Sub'][0].replace('${CanonicalDomainName}', domain);
  return vm.runInNewContext(code + '; handler;');
}
function request(host: string, uri: string, accept = 'text/html') {
  return {method:'GET', uri, headers:{host:{value:host}, accept:{value:accept}}, querystring:{}};
}
test('canonical domain redirect retains deep-link query values and repeats', () => {
  const r = request('old.cloudfront.net', '/projects/example');
  r.querystring = {q:{value:'a%20b',multiValue:[{value:'a%20b'},{value:'x%26y'}]}};
  const response = handler('tasks.abuk.in')({request:r});
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location.value, 'https://tasks.abuk.in/projects/example?q=a%20b&q=x%26y');
  assert.equal(response.headers['cache-control'].value, 'no-store');
});
test('canonical and dev HTML navigation still uses the SPA entry', () => {
  assert.equal(handler('tasks.abuk.in')({request:request('tasks.abuk.in','/projects/example')}).uri, '/index.html');
  assert.equal(handler('')({request:request('dev.cloudfront.net','/projects/example')}).uri, '/index.html');
});
test('assets, API, non-HTML responses and mutations are never redirected or rewritten', () => {
  for (const r of [request('old.cloudfront.net','/assets/missing.js'),request('old.cloudfront.net','/api/v1/workspace'),request('old.cloudfront.net','/projects/example','application/json'),{...request('old.cloudfront.net','/projects/example'),method:'POST'}]) {
    assert.equal(handler('tasks.abuk.in')({request:r}), r);
  }
});
