const FIELDS = ['apiKey', 'baseURL', 'proxy', 'model', 'maxHistory', 'sizeLevel', 'walkEnabled', 'pinGPT', 'topOnFullscreen', 'displayId', 'typeEnabled', 'gazeEnabled', 'edgePeekEnabled', 'voiceEnabled', 'voiceVolume',
  'petName', 'userName', 'personality', 'replyStyle', 'memoryEnabled', 'memories', 'proactiveEnabled'];

(async () => {
  const config = await petAPI.getConfig();
  // 多块屏幕时才显示活动屏幕选项
  const screens = await petAPI.listScreens();
  document.getElementById('displayRow').hidden = screens.length < 2;
  document.getElementById('displayId').replaceChildren(new Option('不限制（跟随所在屏幕）', ''),
    ...screens.map((d, i) => new Option(`屏幕 ${i + 1}${d.primary ? '（主屏）' : ''} ${d.width}×${d.height}`, d.id)));
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el.type === 'checkbox') {
      el.checked = config[key];
    } else {
      el.value = config[key];
    }
  }
  if (config.apiKey) loadModels();
})();

document.getElementById('save').addEventListener('click', async () => {
  const config = {};
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el.type === 'checkbox') {
      config[key] = el.checked;
    } else if (['number', 'range'].includes(el.type)) {
      config[key] = Number(el.value);
    } else {
      config[key] = el.value.trim();
    }
  }
  await petAPI.saveConfig(config);
  window.close();
});

const modelSelect = document.getElementById('modelSelect');
const modelStatus = document.getElementById('modelStatus');

modelSelect.addEventListener('change', () => {
  if (modelSelect.value) document.getElementById('model').value = modelSelect.value;
});
document.getElementById('loadModels').addEventListener('click', loadModels);
document.getElementById('apiKey').addEventListener('change', loadModels);
document.getElementById('baseURL').addEventListener('change', loadModels);
document.getElementById('proxy').addEventListener('change', loadModels);

// 用当前填写的 API Key 和地址读取可用模型，填入下拉框
async function loadModels() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const baseURL = document.getElementById('baseURL').value.trim();
  if (!apiKey) {
    modelStatus.textContent = '请先填写 API Key';
    return;
  }
  modelStatus.textContent = '读取中…';
  const proxy = document.getElementById('proxy').value.trim();
  const { models, error } = await petAPI.listModels(apiKey, baseURL, proxy);
  if (error) {
    modelStatus.textContent = `读取失败：${error}`;
    return;
  }
  const current = document.getElementById('model').value.trim();
  modelSelect.replaceChildren(...models.map(id => new Option(id, id, false, id === current)));
  if (!models.includes(current)) modelSelect.prepend(new Option('— 选择模型 —', '', true, true));
  modelStatus.textContent = `共 ${models.length} 个可用模型`;
}

petAPI.getVersion().then(version => {
  document.getElementById('version').textContent = `当前版本：v${version}`;
});
document.getElementById('checkUpdate').addEventListener('click', () => petAPI.checkUpdate());
document.getElementById('releases').addEventListener('click', () => petAPI.openReleases());

// 人设设定在单独一页，点入口按钮进入，返回回到主设置；保存按钮两页共用
for (const [id, persona] of [['openPersona', true], ['closePersona', false]]) {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('mainPage').hidden = persona;
    document.getElementById('personaPage').hidden = !persona;
    scrollTo(0, 0);
  });
}
