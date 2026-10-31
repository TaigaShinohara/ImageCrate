import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('extension/manifest.json',root),'utf8'));
assert.equal(manifest.manifest_version,3);
assert.equal(manifest.background.type,'module');
assert.match(manifest.content_security_policy.extension_pages,/(?:^|;)\s*img-src 'self' blob:(?:;|$)/,'Original remote/data images cannot reach a page Image element');
assert.ok(!manifest.host_permissions && !manifest.content_scripts && !manifest.externally_connectable);
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*','https://*/*'], 'Site access is optional; request only concrete selected-image hosts at runtime');
assert.ok(!manifest.permissions.some(x=>['debugger','webRequest','history','cookies','tabs'].includes(x)));
assert.deepEqual([...manifest.permissions].sort(),['activeTab','scripting','downloads','storage','alarms'].sort(),'Only the internal recovery alarm supplements temporary page access');
const html=await readFile(new URL('extension/workspace.html',root),'utf8');
assert.ok(!/<script[^>]*>\s*[^<\s]/i.test(html),'Inline scripts are forbidden');
for(const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(!/^https?:/i.test(m[1]),'No remote executable UI assets');
for(const name of await readdir(new URL('extension/',root))) {
  if(!name.endsWith('.js'))continue;
  const path=new URL(`extension/${name}`,root);
  const result=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const source=await readFile(path,'utf8');
  for(const m of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) await readFile(new URL(m[1],path));
}
for(const path of ['workspace.html','workspace.css',manifest.background.service_worker]) await readFile(new URL('extension/'+path,root));
console.log(`${manifest.name}: manifest, permissions, local module references and JavaScript syntax OK`);
