import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePart, saveSettings, destinationLabel, downloadName, permissionOrigins, requiresWorkspace, formatLabel} from '../extension/utils.js';

test('the displayed folder name is exactly the folder used by Chrome, including reserved long names', () => {
  for(const input of ['', '  ', ' .hidden', '../../旅行:*', 'con.'+'x'.repeat(86), '旅行😀'.repeat(100), 'ＡＢＣ. ']) {
    const settings=saveSettings({folderName:input},'ページ');
    const path=downloadName({url:'https://images.test/photo.jpg'},settings.folderName,0,'images');
    assert.equal(path.split('/')[1],settings.folderName);
    assert.equal(sanitizePart(settings.folderName),settings.folderName);
    assert.ok(new TextEncoder().encode(settings.folderName).length<=160);
    assert.ok(!/[\uD800-\uDBFF]$/.test(settings.folderName));
    assert.ok(destinationLabel(settings).endsWith(settings.folderName));
  }
  const fallback=saveSettings({folderName:''},' .hidden');
  assert.equal(fallback.folderName,'hidden');
});

test('custom folders are labeled by the selected handle name without inventing an absolute path', () => {
  const settings=saveSettings({destination:'directory',directoryName:'写真資料',folderName:'作品集'});
  assert.equal(destinationLabel(settings),'選択した「写真資料」 / 作品集');
  assert.equal(saveSettings({destination:'other'}).destination,'downloads');
});

test('folder previews remove leading dots and exposed spaces before reserved-name handling', () => {
  const cases = [
    ['. photos', 'photos'],
    ['. con', '_con'],
    ['... . photos', 'photos'],
    [' . . con. ', '_con'],
    ['.  . CON ', '_CON'],
    ['. \t. CON ', '_. CON'],
    ['. . aux.txt', '_aux.txt'],
    ['．　ＣＯＮ', '_CON'],
    ['. . ', 'ページ'],
    ['my . photos', 'my . photos']
  ];
  for (const [input, expected] of cases) {
    const settings = saveSettings({folderName:input}, 'ページ');
    assert.equal(settings.folderName, expected, input);
    assert.equal(sanitizePart(settings.folderName), expected, input);
    const path = downloadName({url:'https://images.test/photo.jpg'}, settings.folderName, 0, 'images');
    assert.equal(path.split('/')[1], expected, input);
  }
});

test('optional access includes only concrete image hosts, with no query, path, wildcard host, or port', () => {
  assert.deepEqual(permissionOrigins(['https://cdn.test:444/a?token=secret','https://cdn.test/b','http://localhost:1234/x','data:image/png;base64,AA==','bad','https://*/*','https://*.example.test/a.png']),
    ['https://cdn.test/*','http://localhost/*']);
});

test('format settings, filename suffixes and workspace ownership agree', () => {
  for(const format of ['jpg','png','webp']) {
    const settings=saveSettings({format});
    assert.equal(settings.format,format);assert.equal(requiresWorkspace(settings),true);
    assert.ok(downloadName({url:'https://images.test/source.gif'},'Images',0,'images',format).endsWith(`.${format}`));
    assert.ok(formatLabel(format).includes(`.${format}`));
  }
  for(const format of [undefined,'gif','constructor','__proto__']) {
    assert.equal(saveSettings({format}).format,'original');
    assert.equal(formatLabel(format),'元の形式');
  }
  assert.equal(requiresWorkspace(saveSettings()),false);
  assert.equal(requiresWorkspace(saveSettings({destination:'directory'})),true);
});
