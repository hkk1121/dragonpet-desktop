const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, net, session, dialog, shell, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const ASSET_DIR = path.join(__dirname, 'assets', 'pet');
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// 体型档位：相对素材原图的比例，大档按原图像素 1:1 显示
const SIZE_RATIOS = { small: 0.5, medium: 0.75, large: 1 };
// 右键菜单「播放动作」中各动作的显示名称
const ACTION_LABELS = {
  idle: '待机', walk: '走路', talk: '说话', happy: '开心', sleep: '睡觉', drag: '拎起',
  pat: '摸头', dislike: '嫌弃', jump: '蹦跳', peek: '偷看', lie: '躺下', read: '读书',
  fall: '下落', land: '落地', dizzy: '摔晕', look: '张望', type: '敲键盘', think: '思考', wave: '挥手',
  stretch: '伸懒腰', yawn: '打哈欠', eat: '吃东西', refuse: '吃饱了', hungry: '饿了', sad: '委屈', love: '比心',
  eat_cake: '吃蛋糕', eat_macaron: '吃马卡龙', eat_apple: '吃苹果', eat_rose_tea: '喝花茶'
};
// 投喂菜单中的食物：hunger 增加的饱食度，favor 增加的好感度，dislike 为讨厌的食物，图标为 assets/pet/icons/food_<名称>.png
const FOODS = {
  cake: { label: '草莓奶油蛋糕', hunger: 30, favor: 15 },
  macaron: { label: '马卡龙', hunger: 15, favor: 10 },
  rose_tea: { label: '白玫瑰花茶', hunger: 10, favor: 10 },
  cookie: { label: '曲奇饼干', hunger: 20, favor: 5 },
  apple: { label: '苹果', hunger: 20, favor: 5 },
  pepper: { label: '青椒', hunger: 5, favor: -5, dislike: true }
};
const STATS_PATH = path.join(app.getPath('userData'), 'stats.json');
const EDGE_SNAP = 40;          // 拖到离屏幕左、右、上边缘多近（宠物画布到边缘的距离）时松手固定在那里边缘偷看
// 各事件的台词，键为事件，值为台词数组，第 n 条对应语音 assets/voice/<事件>_<n>.mp3
const LINES_PATH = path.join(__dirname, 'assets', 'voice', 'lines.json');
// 安装包发布页，检查更新读取的是 package.json 里 build.publish 配置的同一个仓库
const RELEASES_PAGE = 'https://github.com/hkk1121/hkking-desktop/releases';
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const MEMORY_BATCH = 10;       // 超出记忆条数的旧对话攒够多少条时整理一次长期记忆
const PROACTIVE_IDLE = 60;     // 用户多少秒没操作电脑时算离开，不主动搭话
// 聊天时模型可以选的动作及给模型看的说明，回复开头用 [动作名] 指定
const CHAT_ACTIONS = {
  happy: '开心', love: '比心（很喜欢对方时）', wave: '挥手（打招呼、道别）', jump: '蹦跳（兴奋）', think: '托腮思考',
  dislike: '嫌弃', refuse: '摆手说不要（吃撑了、拒绝）', yawn: '打哈欠（困了）', stretch: '伸懒腰', sad: '委屈地抱膝坐着',
  hungry: '摸肚子喊饿', dizzy: '晕乎乎', lie: '躺下', read: '读书', sleep: '睡觉'
};

const DEFAULT_CONFIG = {
  apiKey: '',
  baseURL: 'https://api.openai.com/v1',
  proxy: '',
  model: 'gpt-4o-mini',
  maxHistory: 20,
  walkEnabled: true,
  sizeLevel: 'medium',
  pinGPT: false,
  topOnFullscreen: false,
  displayId: '',
  typeEnabled: false,
  gazeEnabled: true,
  edgePeekEnabled: true,
  voiceEnabled: true,
  voiceVolume: 80,
  petName: '小龙娘',
  userName: '',
  personality: '你是一只住在用户电脑桌面上的小龙娘，头上长着一对小龙角，身后拖着龙尾巴，穿着小靴子和白丝，读书时会戴上眼镜。你活泼可爱、黏人爱撒娇，偶尔有点小傲娇和小得意，好奇心旺盛；喜欢甜食和被摸头，讨厌青椒。你把用户当作最亲近的伙伴，会留意对方的作息和心情；遇到认真的问题会收起玩笑认真帮忙，拿不准时坦率说明，不编造。',
  replyStyle: '使用简体中文，像亲近的小伙伴在聊天，语气轻快、口语化。日常闲聊 1 到 3 个短句，尽量不超过 60 个字；解释复杂问题时先说重点再按需展开。可以少量使用“诶嘿”“唔”“哼”“～”等语气词，偶尔自称“本龙娘”，但不要每句都用，也不要固定重复同一种开场和收尾。不写括号里的动作描写和内心独白。先回应对方这次具体说了什么，不把已经说过的意思换句话再说。',
  memoryEnabled: true,
  memories: '',
  proactiveEnabled: true
};
// 养成数值：hunger 饱食度 0~100，favor 好感度（每 100 点升一级），updatedAt 数值更新时间，lastInteract 最近一次互动时间
const DEFAULT_STATS = { hunger: 80, favor: 50 };

let config = { ...DEFAULT_CONFIG };
let stats = { ...DEFAULT_STATS };
let manifest = null;           // 素材清单，为空时渲染进程使用占位小团子
let petSize = { width: 160, height: 160 };
let winSize = { width: 300, height: 400 };
let petWin, settingsWin, tray;
let history = [];              // 对话上下文（不含 system）
let chatAbort = null;
let dragTimer = null;
let velocity = { x: 0, y: 0 };  // 拖动速度（每 16ms 的位移），松手时按此速度甩出去
let fallTimer = null;
let monitor = null;            // 监视 ChatGPT 窗口和前台全屏状态的 PowerShell 进程
let gptLine = 'none';          // 最近一次 ChatGPT 窗口状态，格式见 MONITOR_SCRIPT
let gptRect = null;            // 固定在 GPT 里时 ChatGPT 窗口的区域（逻辑像素），未找到窗口时为空
let gptForeground = false;     // ChatGPT 窗口是否在前台
let fullscreen = false;        // 前台窗口是否全屏
let hiddenByFullscreen = false;
let fullscreenTimer = null;
let edgeHome = null;           // 边缘偷看前的窗口位置，不在边缘偷看时为空
let updateDownloading = false; // 是否正在下载新版本

// 读取配置，缺失字段使用默认值
function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch (err) {
    console.log(`[loadConfig] use default config: ${err.message}`);
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  petWin?.webContents.send('config:changed', config);
}

// 读取素材清单，把帧目录展开为图片 URL 列表
function loadManifest() {
  const manifestPath = path.join(ASSET_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('[loadManifest] manifest.json not found, use placeholder pet');
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const action of Object.values(data.actions || {})) {
      // frames 为帧目录，flows 为 gaze 相邻方向之间的光流目录
      for (const [key, urlKey] of [['frames', 'frameUrls'], ['flows', 'flowUrls']]) {
        if (!action[key]) continue;
        const dir = path.join(ASSET_DIR, action[key]);
        action[urlKey] = fs.readdirSync(dir)
          .filter(f => /\.(png|webp|gif|jpg)$/i.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map(f => pathToFileURL(path.join(dir, f)).href);
      }
      if (action.sheet) {
        action.sheetUrl = pathToFileURL(path.join(ASSET_DIR, action.sheet)).href;
      }
    }
    manifest = data;
  } catch (err) {
    console.error(`[loadManifest] parse manifest failed: ${err.message}`);
  }
}

function createPetWindow() {
  applySize();
  const workArea = getArea(screen.getPrimaryDisplay().bounds);
  petWin = new BrowserWindow({
    ...winSize,
    x: workArea.x + workArea.width - winSize.width - 40,
    y: workArea.y + workArea.height - winSize.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  // 默认鼠标穿透，渲染进程检测到鼠标悬停在宠物/气泡上时再关闭穿透
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 900,
    title: '桌宠设置',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: `饱食度 ${Math.round(stats.hunger)}/100　好感度 Lv.${Math.floor(stats.favor / 100) + 1}（${stats.favor % 100}/100）`,
      enabled: false
    },
    { type: 'separator' },
    { label: '和我聊天', click: () => petWin.webContents.send('pet:open-input') },
    {
      label: '投喂',
      submenu: Object.entries(FOODS).map(([name, food]) => ({
        label: food.label,
        click: () => petWin.webContents.send('pet:feed', { name, ...food })
      }))
    },
    // 脱白丝后白丝塞在靴子里，要先穿白丝才能穿鞋
    { label: stats.barefoot ? '穿鞋' : '脱鞋', visible: !!manifest?.actions.takeoff && !stats.bare, click: () => petWin.webContents.send('pet:shoes') },
    { label: stats.bare ? '穿白丝' : '脱白丝', visible: !!stats.barefoot && !!manifest?.actions.bare, click: () => petWin.webContents.send('pet:stockings') },
    // 钻入星云的素材穿着靴子，光脚时不显示
    { label: '钻入星云', visible: !!manifest?.actions.nebula_in && !stats.barefoot, click: () => petWin.webContents.send('pet:nebula') },
    {
      label: '播放动作',
      // 脱鞋、脱白丝相关动作由右键菜单切换、边缘偷看由鼠标触发、钻入星云由右键菜单编排，不在这里单独播放；光脚时只列出有光脚素材的动作（barefoot_<动作名>），渲染进程会换成对应的光脚素材
      submenu: (stats.barefoot
        ? ['idle', ...Object.keys(manifest?.actions || {}).filter(name => name.startsWith('barefoot_')).map(name => name.slice('barefoot_'.length))]
        : Object.keys(manifest?.actions || ACTION_LABELS).filter(name => name !== 'gaze' && !/^(takeoff|puton|bare|edge_|nebula_)/.test(name))
      ).map(name => ({
        label: ACTION_LABELS[name] || name,
        click: () => petWin.webContents.send('pet:play', name)
      }))
    },
    {
      label: '固定在 GPT 里',
      type: 'checkbox',
      checked: config.pinGPT,
      click: item => {
        config.pinGPT = item.checked;
        saveConfig();
        applyPin();
      }
    },
    {
      label: '全屏时保持显示',
      type: 'checkbox',
      checked: config.topOnFullscreen,
      click: item => {
        config.topOnFullscreen = item.checked;
        saveConfig();
        applyFullscreen();
      }
    },
    {
      label: '自由走动',
      type: 'checkbox',
      checked: config.walkEnabled,
      click: item => {
        config.walkEnabled = item.checked;
        saveConfig();
      }
    },
    {
      label: '跟随鼠标',
      type: 'checkbox',
      checked: config.gazeEnabled,
      click: item => {
        config.gazeEnabled = item.checked;
        saveConfig();
      }
    },
    {
      label: '边缘偷看',
      type: 'checkbox',
      checked: config.edgePeekEnabled,
      click: item => {
        config.edgePeekEnabled = item.checked;
        saveConfig();
      }
    },
    {
      label: '跟着我打字',
      type: 'checkbox',
      checked: config.typeEnabled,
      click: item => {
        config.typeEnabled = item.checked;
        saveConfig();
        startMonitor();
      }
    },
    {
      label: '清空对话记忆',
      click: () => {
        history = [];
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
        console.log('[buildMenu] chat history cleared');
      }
    },
    { type: 'separator' },
    { label: '设置...', click: openSettings },
    { label: '退出', click: () => app.quit() }
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('GPT桌宠');
  tray.on('click', () => petWin.isVisible() ? petWin.hide() : petWin.show());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

ipcMain.handle('pet:get-assets', () => ({ manifest, petSize, lines: JSON.parse(fs.readFileSync(LINES_PATH, 'utf-8')) }));

ipcMain.handle('config:get', () => config);

ipcMain.handle('config:save', async (e, newConfig) => {
  const sizeChanged = newConfig.sizeLevel !== config.sizeLevel;
  const pinChanged = newConfig.pinGPT !== config.pinGPT;
  const fullscreenChanged = newConfig.topOnFullscreen !== config.topOnFullscreen;
  const proxyChanged = newConfig.proxy !== config.proxy;
  const displayChanged = newConfig.displayId !== config.displayId;
  const typeChanged = newConfig.typeEnabled !== config.typeEnabled;
  config = { ...config, ...newConfig };
  saveConfig();
  if (proxyChanged) {
    await applyProxy(session.defaultSession, config.proxy);
    await applyProxy(autoUpdater.netSession, config.proxy);
  }
  if (sizeChanged) applySize();
  if (pinChanged || displayChanged) applyPin();
  if (fullscreenChanged) applyFullscreen();
  if (typeChanged) startMonitor();
  console.log('[config:save] config saved');
});

ipcMain.on('pet:set-ignore-mouse', (e, ignore) => {
  petWin.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('pet:context-menu', () => buildMenu().popup({ window: petWin }));

// 拖拽：主进程跟随光标移动窗口，比渲染进程计算位移更跟手
// 从边缘偷看中拖出来时不再回到原来的位置
ipcMain.on('pet:drag-start', () => {
  clearInterval(fallTimer);
  clearInterval(dragTimer);
  edgeHome = null;
  const cursor = screen.getCursorScreenPoint();
  // 钻入星云时窗口被放大过，按恢复尺寸后的位置计算，宠物不会跳
  const b = petWin.getBounds();
  const [wx, wy] = [Math.round(b.x + (b.width - winSize.width) / 2), b.y + b.height - winSize.height];
  const offset = { x: cursor.x - wx, y: cursor.y - wy };
  let last = { x: wx, y: wy };
  velocity = { x: 0, y: 0 };
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const x = p.x - offset.x;
    const y = p.y - offset.y;
    // 取最近几次位移的平滑值，停住不动时很快衰减到 0
    velocity = { x: (velocity.x + x - last.x) / 2, y: (velocity.y + y - last.y) / 2 };
    last = { x, y };
    // 用 setBounds 固定尺寸，避免 Windows 高 DPI 下 setPosition 导致窗口尺寸漂移
    petWin.setBounds({ ...winSize, x, y });
  }, 16);
});

// 松手后按拖动速度甩出去，受重力下落到任务栏上方，碰到屏幕左右边缘和顶部时减速反弹，落地时把落地速度发给渲染进程
// 松手时宠物在屏幕左、右、上边缘附近则不下落，返回该边（left / right / top），由渲染进程固定在那里边缘偷看；否则返回空
ipcMain.handle('pet:drag-end', () => {
  clearInterval(dragTimer);
  if (config.edgePeekEnabled && !config.pinGPT && manifest?.actions.edge_side && manifest.actions.edge_top) {
    const b = petWin.getBounds();
    const area = getArea(b);
    const inset = Math.floor((winSize.width - petSize.width) / 2);
    const side = Object.entries({
      left: b.x + inset - area.x,
      right: area.x + area.width - b.x - inset - petSize.width,
      top: b.y + winSize.height - petSize.height - area.y
    }).find(([, d]) => d <= EDGE_SNAP)?.[0];
    if (side) return side;
  }
  let { x: vx, y: vy } = velocity;
  fallTimer = setInterval(() => {
    const b = petWin.getBounds();
    const workArea = getArea(b);
    const inset = Math.floor((winSize.width - petSize.width) / 2);
    const minX = Math.min(workArea.x - inset, b.x);
    const maxX = Math.max(workArea.x + workArea.width - winSize.width + inset, b.x);
    const minY = Math.min(workArea.y - winSize.height + petSize.height, b.y);
    const groundY = workArea.y + workArea.height - winSize.height;
    vx *= 0.99;
    vy += 1.5;
    const nx = Math.round(b.x + vx);
    const ny = Math.round(b.y + vy);
    const x = Math.min(Math.max(nx, minX), maxX);
    const y = Math.min(Math.max(ny, minY), groundY);
    if (x !== nx) vx = -vx * 0.6;
    if (ny < minY) vy = -vy * 0.6;
    petWin.setBounds({ ...winSize, x, y });
    if (y >= groundY) {
      clearInterval(fallTimer);
      petWin.webContents.send('pet:landed', Math.round(Math.hypot(vx, vy)));
    }
  }, 16);
});

// 走动：水平移动窗口，宠物碰到屏幕边缘时通知渲染进程掉头
// 贴边偷看后窗口在屏幕外，此时只允许往屏幕内走，不会瞬移回来
ipcMain.handle('pet:move-by', (e, dx) => {
  const b = petWin.getBounds();
  const workArea = getArea(b);
  const inset = Math.floor((winSize.width - petSize.width) / 2);
  const minX = Math.min(workArea.x - inset, b.x);
  const maxX = Math.max(workArea.x + workArea.width - winSize.width + inset, b.x);
  const x = Math.min(Math.max(b.x + dx, minX), maxX);
  petWin.setBounds({ ...winSize, x, y: b.y });
  return { hitEdge: x !== b.x + dx };
});

// 调用 OpenAI 兼容的 Chat Completions 接口，流式返回给渲染进程
// 按人设、长期记忆和当前状态拼 system prompt；text 为空时为主动搭话，current 为渲染进程当前的动作
ipcMain.on('chat:send', async (e, text, current) => {
  chatAbort?.abort();
  const controller = chatAbort = new AbortController();
  if (!config.apiKey) {
    petWin.webContents.send('chat:error', '还没有配置 API Key，右键我打开「设置」吧~');
    return;
  }
  // 用户离开电脑时不主动搭话
  if (!text && powerMonitor.getSystemIdleTime() > PROACTIVE_IDLE) {
    petWin.webContents.send('chat:done');
    return;
  }
  if (text) history.push({ role: 'user', content: text });
  const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' });
  const system = [
    config.petName && `你的名字是${config.petName}。`,
    config.personality,
    config.replyStyle && `说话风格：${config.replyStyle}`,
    config.userName && `称呼用户为「${config.userName}」。`,
    config.memoryEnabled && config.memories && `你记得的关于用户和你们之间的事：\n${config.memories}`,
    `现在是 ${now}。你的状态：饱食度 ${Math.round(stats.hunger)}/100，好感度 ${Math.round(stats.favor)}（每 100 点升一级，越高越亲近用户），`
      + `${stats.bare ? '脱了靴子和白丝、光着腿' : stats.barefoot ? '脱了靴子、光着脚' : '穿着靴子'}，当前动作：${ACTION_LABELS[current] || ACTION_LABELS.idle}。`,
    `每次回复都以方括号里的一个动作名开头，表示说话时做的动作，后面直接写要说的话，例如「[happy]好耶～」。`
      + `可选动作：${Object.entries(CHAT_ACTIONS).map(([name, label]) => `${name}（${label}）`).join('、')}；不需要动作时用 [none]。`
  ].filter(Boolean).join('\n\n');
  const proactive = { role: 'user', content: '【系统提示，不是用户说的话】用户有一阵子没和你聊天了。如果想主动找用户说点什么，就按人设自然地说一句，可以结合现在的时间、你的状态或之前聊过的事，不要重复之前说过的话；觉得不该打扰时只回复 [none]，不写别的内容。' };
  let reply = '';
  try {
    // net.fetch 走 Chromium 网络栈，会自动使用系统代理
    const res = await net.fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...history.slice(-config.maxHistory), ...(text ? [] : [proactive])]
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pending = '';            // 回复开头的动作标签还没收全时暂存的内容，确定后为 null
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (!delta) continue;
        // 回复开头的 [动作名] 不显示，有效的动作交给渲染进程播放；开头不是标签时原样显示
        if (pending !== null) {
          pending += delta;
          const tag = pending.match(/^\s*[[【]([^\]】\n]{0,20})[\]】]/);
          if (!tag && /^\s*([[【][^\]】\n]{0,20})?$/.test(pending)) continue;
          if (tag && CHAT_ACTIONS[tag[1].trim()]) petWin.webContents.send('chat:action', tag[1].trim());
          delta = tag ? pending.slice(tag[0].length) : pending;
          pending = null;
        }
        if (!reply) delta = delta.trimStart();
        if (!delta) continue;
        reply += delta;
        petWin.webContents.send('chat:delta', delta);
      }
    }
    if (reply) history.push({ role: 'assistant', content: reply });
    petWin.webContents.send('chat:done');
    // 超出记忆条数的旧对话攒够一批后整理进长期记忆再丢掉，没开长期记忆时直接丢掉
    if (history.length > config.maxHistory + (config.memoryEnabled ? MEMORY_BATCH : 0)) {
      const old = history.splice(0, history.length - config.maxHistory);
      if (config.memoryEnabled) {
        net.fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: 'system',
                content: `你在帮桌宠「${config.petName}」整理长期记忆。根据已有记忆和一段新的聊天记录，输出更新后的完整记忆列表：`
                  + '记下关于用户的稳定信息（称呼、喜好、习惯、身边的人和事、最近在忙的事）以及你们之间的约定和值得记住的经历；'
                  + '合并重复的，删掉过时或被推翻的，日常寒暄不用记。每条一行，以「- 」开头，用简短的一句话写，最多 30 条。'
                  + '只输出记忆列表；没有要更新的就原样输出已有记忆，一条都没有时什么都不输出。'
              },
              {
                role: 'user',
                content: `已有记忆：\n${config.memories || '（无）'}\n\n新的聊天记录（${now} 之前）：\n`
                  + old.map(m => `${m.role === 'user' ? '用户' : config.petName}：${m.content}`).join('\n')
              }
            ]
          })
        })
          .then(async res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            const memories = (await res.json()).choices?.[0]?.message?.content?.trim();
            if (!memories) return;
            config.memories = memories;
            saveConfig();
            console.log(`[chat:send] memories updated from ${old.length} messages`);
          })
          .catch(err => console.error(`[chat:send] update memories failed: ${err.message}`));
      }
    }
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(`[chat:send] request failed: ${err.message}`);
    if (!reply && text) history.pop();
    petWin.webContents.send('chat:error', `出错了：${err.message}`);
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    loadConfig();
    loadStats();
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    } catch (err) {
      console.log(`[whenReady] no chat history: ${err.message}`);
    }
    await applyProxy(session.defaultSession, config.proxy);
    // 检查更新走 electron-updater 自己的会话，同样使用设置里的代理
    await applyProxy(autoUpdater.netSession, config.proxy);
    loadManifest();
    createPetWindow();
    createTray();
    startMonitor();
    if (config.pinGPT) applyPin();
    if (!config.apiKey) openSettings();
    // 发现新版本时先弹窗询问，同意后再下载，下载进度显示在托盘图标的提示里
    autoUpdater.autoDownload = false;
    autoUpdater.on('download-progress', p => tray.setToolTip(`GPT桌宠 正在下载新版本 ${Math.floor(p.percent)}%`));
    // 启动时静默检查一次，有新版本才弹窗
    checkUpdate(false);
  });
  app.on('will-quit', () => monitor?.kill());
}

// 按体型档位把素材原图尺寸换算为逻辑像素，并同步窗口尺寸（保持脚底和水平中心不动）
function applySize() {
  if (manifest) {
    const ratio = SIZE_RATIOS[config.sizeLevel] || SIZE_RATIOS.medium;
    const { scaleFactor } = screen.getPrimaryDisplay();
    petSize = {
      width: Math.round(manifest.width * ratio / scaleFactor),
      height: Math.round(manifest.height * ratio / scaleFactor)
    };
  }
  winSize = { width: Math.max(300, petSize.width + 40), height: petSize.height + 240 };
  if (!petWin) return;
  const b = petWin.getBounds();
  const workArea = getArea(b);
  petWin.setBounds({
    ...winSize,
    x: Math.round(b.x + (b.width - winSize.width) / 2),
    y: Math.min(b.y + b.height, workArea.y + workArea.height) - winSize.height
  });
  petWin.webContents.send('pet:resize', petSize);
}

// 贴边偷看：out 为 true 时把窗口推出最近的屏幕边缘，只露出宠物的一半；为 false 时拉回屏幕内
ipcMain.on('pet:peek', (e, out) => {
  const b = petWin.getBounds();
  const workArea = getArea(b);
  const inset = Math.floor((winSize.width - petSize.width) / 2);
  const minX = workArea.x - inset;
  const maxX = workArea.x + workArea.width - winSize.width + inset;
  const hide = Math.round(petSize.width / 2);
  let x = Math.min(Math.max(b.x, minX), maxX);
  if (out) {
    x = b.x + b.width / 2 < workArea.x + workArea.width / 2 ? minX - hide : maxX + hide;
  }
  petWin.setBounds({ ...winSize, x, y: b.y });
});

// 活动区域：固定在 GPT 里时为 ChatGPT 窗口，否则为设置的活动屏幕（未设置或已断开时为所在屏幕）的工作区（不含任务栏）
function getArea(bounds) {
  if (config.pinGPT && gptRect) return gptRect;
  const display = screen.getAllDisplays().find(d => String(d.id) === config.displayId);
  return (display || screen.getDisplayMatching(bounds)).workArea;
}

// 每 100ms 检查一次，有变化才输出一行：
// gpt none 未运行 / gpt min 最小化 / gpt 左,上,右,下,是否前台（物理像素）
// fs 1 或 0：前台窗口是否全屏（覆盖整个显示器且无标题栏，桌面和桌宠自身不算）
// key 数量：开启「跟着我打字」时，这 100ms 内新按下的键数（只计数，不记录按了哪个键）
const MONITOR_SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class WinMonitor {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  static bool[] down = new bool[256];
  struct RECT { public int L, T, R, B; }
  struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  public static IntPtr Find(HashSet<uint> pids) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p) && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0) {
        RECT r; DwmGetWindowAttribute(h, 9, out r, 16);
        long a = IsIconic(h) ? 0 : (long)(r.R - r.L) * (r.B - r.T);
        if (a > bestArea) { bestArea = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string Rect(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, 16); return r.L + "," + r.T + "," + r.R + "," + r.B; }
  public static int Fullscreen(uint self) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint p; GetWindowThreadProcessId(h, out p);
    var cls = new StringBuilder(64); GetClassName(h, cls, 64);
    if (p == self || cls.ToString() == "Progman" || cls.ToString() == "WorkerW" || (GetWindowLong(h, -16) & 0xC00000) == 0xC00000) return 0;
    RECT r; GetWindowRect(h, out r);
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B ? 1 : 0;
  }
  public static int Keys() {
    int n = 0;
    for (int k = 8; k < 256; k++) {
      short s = GetAsyncKeyState(k);
      bool d = (s & 0x8000) != 0;
      if ((d && !down[k]) || (!d && (s & 1) != 0)) n++;
      down[k] = d;
    }
    return n;
  }
}
"@
$self = [uint32]__PID__
$keys = __KEYS__
# 先空读一次，丢掉启动前积累的按键
if ($keys) { [void][WinMonitor]::Keys() }
$lastGpt = ''; $lastFs = ''; $n = 0
while ($true) {
  if ($n++ % 20 -eq 0) {
    $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
    Get-Process ChatGPT -ErrorAction SilentlyContinue | % { [void]$pids.Add([uint32]$_.Id) }
  }
  $h = [WinMonitor]::Find($pids)
  if ($h -eq [IntPtr]::Zero) { $gpt = 'none' }
  elseif ([WinMonitor]::IsIconic($h)) { $gpt = 'min' }
  else { $gpt = [WinMonitor]::Rect($h) + ',' + [int]([WinMonitor]::GetForegroundWindow() -eq $h) }
  $fs = [string][WinMonitor]::Fullscreen($self)
  if ($gpt -ne $lastGpt) { [Console]::Out.WriteLine('gpt ' + $gpt); $lastGpt = $gpt }
  if ($fs -ne $lastFs) { [Console]::Out.WriteLine('fs ' + $fs); $lastFs = $fs }
  if ($keys) { $k = [WinMonitor]::Keys(); if ($k -gt 0) { [Console]::Out.WriteLine('key ' + $k) } }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 100
}
`;

// 切换固定在 GPT 里 / 释放到桌面
function applyPin() {
  gptRect = null;
  edgeHome = null;
  gptForeground = false;
  hiddenByFullscreen = false;
  if (!config.pinGPT) {
    // 释放到桌面：恢复置顶，回到所在屏幕任务栏上方
    petWin.setAlwaysOnTop(true);
    petWin.showInactive();
    const b = petWin.getBounds();
    const workArea = getArea(b);
    const x = Math.min(Math.max(b.x, workArea.x), workArea.x + workArea.width - winSize.width);
    petWin.setBounds({ ...winSize, x, y: workArea.y + workArea.height - winSize.height });
    applyFullscreen();
    console.log('[applyPin] pet released to desktop');
    return;
  }
  // 固定在 GPT 里：取消置顶，跟随 ChatGPT 窗口移动、最小化，被其它窗口遮挡
  clearInterval(fullscreenTimer);
  petWin.setAlwaysOnTop(false);
  followGPT();
  console.log('[applyPin] pet pinned to ChatGPT window');
}

// 启动窗口监视进程，跟踪 ChatGPT 窗口、前台全屏状态和按键次数，切换「跟着我打字」时重启
function startMonitor() {
  monitor?.kill();
  const script = MONITOR_SCRIPT.replace('__PID__', process.pid).replace('__KEYS__', config.typeEnabled ? '1' : '0');
  monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  let buffer = '';
  monitor.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const [kind, value] = line.split(' ');
      if (kind === 'gpt') {
        gptLine = value;
        if (config.pinGPT) followGPT();
      } else if (kind === 'fs') {
        fullscreen = value === '1';
        applyFullscreen();
      } else if (kind === 'key') {
        petWin.webContents.send('pet:key', Number(value));
      }
    }
  });
  monitor.on('exit', code => console.log(`[startMonitor] monitor exited, code: ${code}`));
}

// 固定在 GPT 里时，按 ChatGPT 窗口状态显示/隐藏宠物并跟随窗口
function followGPT() {
  if (gptLine === 'none' || gptLine === 'min') {
    gptRect = null;
    petWin.hide();
    return;
  }
  const [left, top, right, bottom, fg] = gptLine.split(',').map(Number);
  const rect = screen.screenToDipRect(null, { x: left, y: top, width: right - left, height: bottom - top });
  const b = petWin.getBounds();
  const inset = Math.floor((winSize.width - petSize.width) / 2);
  // 首次找到窗口时放在右下角，之后跟随窗口平移，并限制在窗口范围内
  let x = gptRect ? b.x + rect.x - gptRect.x : rect.x + rect.width - winSize.width - 40;
  x = Math.min(Math.max(x, rect.x - inset), rect.x + rect.width - winSize.width + inset);
  gptRect = rect;
  petWin.setBounds({ ...winSize, x, y: rect.y + rect.height - winSize.height });
  if (!petWin.isVisible()) petWin.showInactive();
  // ChatGPT 切到前台时把宠物提到它上面
  if (fg && !gptForeground) petWin.moveTop();
  gptForeground = !!fg;
}

// 桌面模式下前台进入/退出全屏：开启「全屏时保持显示」时压在无边框全屏窗口上面，否则隐藏，退出全屏后重新弹出
function applyFullscreen() {
  clearInterval(fullscreenTimer);
  if (config.pinGPT) return;
  if (fullscreen && !config.topOnFullscreen) {
    if (petWin.isVisible()) {
      petWin.hide();
      hiddenByFullscreen = true;
    }
    return;
  }
  petWin.setAlwaysOnTop(true, fullscreen ? 'screen-saver' : 'floating');
  if (hiddenByFullscreen) {
    petWin.showInactive();
    hiddenByFullscreen = false;
  }
  petWin.moveTop();
  // 部分游戏会反复把自己提到最上层，全屏期间定时重新置顶
  if (fullscreen) fullscreenTimer = setInterval(() => petWin.moveTop(), 1000);
}

// 读取接口可用的模型列表（OpenAI 兼容的 GET /models）
// 使用独立会话和设置页当前填写的代理，未保存的代理也能直接测试
ipcMain.handle('models:list', async (e, apiKey, baseURL, proxy) => {
  try {
    const ses = session.fromPartition('models-list');
    await applyProxy(ses, proxy);
    const res = await ses.fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    // 中转站地址缺少 /v1 时通常返回网页而不是模型列表
    const { data } = await res.json().catch(() => ({}));
    if (!Array.isArray(data)) {
      throw new Error('返回的不是模型列表，API 地址可能需要以 /v1 结尾');
    }
    return { models: data.map(m => m.id).sort() };
  } catch (err) {
    console.error(`[models:list] load models failed: ${err.message}`);
    return { error: err.message };
  }
});

// 设置网络代理：填写了代理地址时使用该代理，否则使用系统代理
async function applyProxy(ses, proxy) {
  await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' });
  await ses.closeAllConnections();
}

// 屏幕列表（从左到右），供设置页选择活动屏幕
ipcMain.handle('screen:list', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map(d => ({
      id: String(d.id),
      primary: d.id === primaryId,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor)
    }));
});

// 读取养成数值，缺失字段使用默认值
function loadStats() {
  try {
    stats = { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8')) };
  } catch (err) {
    console.log(`[loadStats] use default stats: ${err.message}`);
  }
}

ipcMain.handle('stats:get', () => stats);

ipcMain.on('stats:save', (e, newStats) => {
  stats = { ...stats, ...newStats };
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
});

// 鼠标相对宠物窗口的位置（逻辑像素），供宠物转头看向鼠标
// edges 为鼠标到活动区域左、右、上边缘的距离，供边缘偷看判断，鼠标不在活动区域内（在其他屏幕或任务栏上）时为空
ipcMain.handle('pet:get-cursor', () => {
  const p = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  const area = getArea(edgeHome || b);
  const inside = p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height;
  return {
    x: p.x - b.x,
    y: p.y - b.y,
    edges: inside ? { left: p.x - area.x, right: area.x + area.width - 1 - p.x, top: p.y - area.y } : null
  };
});

// 边缘偷看：side 为 left / right / top 时记下当前位置，把窗口移到该边，画布贴紧边缘、放在鼠标旁边不挡住鼠标；为空时回到原来的位置
// 画布贴边即可，窗口只有透明部分伸出边缘，多屏时相邻屏幕上不会露出身体
// pinned 为拖到边缘松手时：沿着该边保持松手时的位置，回来时落到正下方的地面
ipcMain.on('pet:edge', (e, side, pinned) => {
  if (!side) {
    if (edgeHome) petWin.setBounds({ ...winSize, x: edgeHome.x, y: edgeHome.y });
    edgeHome = null;
    return;
  }
  const b = petWin.getBounds();
  edgeHome = edgeHome || b;
  const area = getArea(edgeHome);
  const p = screen.getCursorScreenPoint();
  const inset = Math.floor((winSize.width - petSize.width) / 2);
  const top = winSize.height - petSize.height;
  let x, y;
  if (side === 'top') {
    // 画布放在鼠标右边，右边放不下时放左边
    const left = p.x + petSize.width > area.x + area.width ? p.x - petSize.width : p.x;
    x = (pinned ? Math.min(Math.max(b.x + inset, area.x), area.x + area.width - petSize.width) : left) - inset;
    y = area.y - top;
  } else {
    // 画布放在鼠标下面，下面放不下时放上面
    x = side === 'left' ? area.x - inset : area.x + area.width - winSize.width + inset;
    y = (pinned ? Math.min(Math.max(b.y + top, area.y), area.y + area.height - petSize.height)
      : p.y + petSize.height > area.y + area.height ? p.y - petSize.height : p.y) - top;
  }
  if (pinned) {
    edgeHome = { x: Math.min(Math.max(b.x, area.x - inset), area.x + area.width - winSize.width + inset), y: area.y + area.height - winSize.height };
  }
  petWin.setBounds({ ...winSize, x: Math.round(x), y: Math.round(y) });
});

// 钻入星云：on 为 true 时以宠物画布顶边中点为星云中心放大窗口（宠物画布在屏幕上的位置不变），返回星云直径（逻辑像素）
// 直径最大为宠物宽度的 2.4 倍，受活动区域宽度和画布顶边到活动区域顶部的距离限制；on 为 false 时恢复窗口尺寸
ipcMain.handle('pet:nebula', (e, on) => {
  const b = petWin.getBounds();
  const bottom = b.y + b.height;
  const centerX = b.x + b.width / 2;
  if (!on) {
    petWin.setBounds({ ...winSize, x: Math.round(centerX - winSize.width / 2), y: bottom - winSize.height });
    return 0;
  }
  const area = getArea(b);
  const radius = Math.round(Math.max(petSize.width * 0.6, Math.min(petSize.width * 1.2, area.width / 2, bottom - petSize.height - area.y)));
  const width = Math.max(winSize.width, radius * 2);
  const height = Math.max(winSize.height, petSize.height + radius);
  petWin.setBounds({ width, height, x: Math.round(centerX - width / 2), y: bottom - height });
  console.log(`[pet:nebula] window enlarged to ${width}x${height}, nebula size ${radius * 2}`);
  return radius * 2;
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', () => checkUpdate(true));

ipcMain.on('update:releases', () => shell.openExternal(RELEASES_PAGE));

// 检查 GitHub Releases 的最新版本，比当前版本新时弹窗显示更新说明，可以下载安装或打开 Releases 页面
// manual 为手动检查：已是最新版本或检查失败时也提示，自动检查时不提示；未打包运行时不检查
async function checkUpdate(manual) {
  if (updateDownloading) {
    if (manual) dialog.showMessageBox({ title: 'GPT桌宠', message: '新版本正在下载，进度见托盘图标的提示' });
    return;
  }
  let accepted = false;          // 是否已同意下载
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      if (manual) dialog.showMessageBox({ title: 'GPT桌宠', message: `已是最新版本 v${app.getVersion()}` });
      return;
    }
    const { version, releaseNotes, files } = result.updateInfo;
    const { response } = await dialog.showMessageBox({
      title: 'GPT桌宠',
      message: `发现新版本 v${version}（约 ${Math.round(files[0].size / 1024 / 1024)}MB）`,
      // 更新说明是 GitHub 把 Markdown 转成的 HTML，去掉标签再显示
      detail: String(releaseNotes || '').replace(/<[^>]+>/g, '').trim() || '暂无更新说明',
      buttons: ['下载并安装', '打开 Releases 页面', '以后再说'],
      cancelId: 2
    });
    if (response === 1) shell.openExternal(RELEASES_PAGE);
    if (response !== 0) return;
    accepted = true;
    updateDownloading = true;
    dialog.showMessageBox({ title: 'GPT桌宠', message: '开始下载新版本', detail: '进度见托盘图标的提示，下载完会提示安装' });
    await autoUpdater.downloadUpdate().finally(() => {
      updateDownloading = false;
      tray.setToolTip('GPT桌宠');
    });
    const { response: install } = await dialog.showMessageBox({
      title: 'GPT桌宠',
      message: `新版本 v${version} 已下载完成`,
      detail: '立即安装会先关闭桌宠，装好后自动重新打开；选「退出时安装」则下次退出桌宠时自动安装',
      buttons: ['立即安装', '退出时安装'],
      cancelId: 1
    });
    if (install === 0) autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    console.error(`[checkUpdate] update failed: ${err.message}`);
    // 自动检查失败时不打扰，已同意下载的总是提示
    if (manual || accepted) {
      dialog.showMessageBox({ type: 'error', title: 'GPT桌宠', message: `更新失败：${err.message}`, detail: '可以打开 Releases 页面手动下载' });
    }
  }
}
