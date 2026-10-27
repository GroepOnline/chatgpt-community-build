import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { settingsContract, UI } = require(path.join(process.cwd(), 'linux-features/community-features-in-gui-settings/patch.js'));
const fixture = [
  'function Js(){let r,n,i;let label=(0,$.jsx)(pi,{slug:`general-settings`});return (0,$.jsxs)(di,{title:r,children:[n,i]})}',
  'function Xs(){let t;return (0,$.jsxs)(H,{children:[t,(0,$.jsx)(H.Content,{children:(0,$.jsxs)(ce,{children:[]})})]})}',
  'function Qs(){let id=`settings.openSourceLicenses.view`;return (0,$.jsx)(w,{label:n,description:r,control:(0,$.jsx)(ye,{color:`secondary`,size:`toolbar`,onClick:i,children:a})})}',
  'function codexLinuxStartMinimizedSetting(){let React=ot(),{platform}=pn();return null}',
  'function codexLinuxReasoningVisibilitySetting(){let React=ot(),{platform}=pn(),intl=R(),label=1;return null}',
  'const intro=`settings.general.groupTitle`;',
].join('\n');
test('native React-compiler General settings supports an embedded Community catalog', () => {
  const c = settingsContract(fixture);
  assert.ok(c, 'new settings layout is supported');
  assert.deepEqual([c.row, c.button, c.section, c.stack, c.reactFactory, c.platformHook, c.intlHook, c.jsx],
    ['w', 'ye', 'H', 'ce', 'ot', 'pn', 'R', '$']);
  const injected = fixture.replace('children:[n,i]', 'children:[(0,$.jsx)(' + UI + ',{}),n,i]');
  assert.ok(settingsContract(injected)?.render[0].includes('children:[(0,$.jsx)(' + UI + ',{}),'));
});
test('unsupported and ambiguous settings layouts fail closed', () => {
  assert.equal(settingsContract(fixture.replace('settings.openSourceLicenses.view','unavailable')), null);
  assert.equal(settingsContract(fixture.replace('children:[n,i]','children:[n,x,i]')), null);
  assert.equal(settingsContract(fixture.replace('function Js()', 'function Js(a)')), null);
  assert.equal(settingsContract(fixture + '\nfunction Extra(){return (0,$.jsx)(pi,{slug:`general-settings`})}'), null);
});
