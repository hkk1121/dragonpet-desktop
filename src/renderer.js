const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const inputBox = document.getElementById('input-box');
const chatInput = document.getElementById('chat-input');
const foodImg = document.getElementById('food');
const nebulaCanvas = document.getElementById('nebula');
const nebulaCtx = nebulaCanvas.getContext('2d');
const nebulaImg = new Image();

const SLEEP_AFTER = 60 * 1000;    // 无交互多久后睡觉
const HEAD_ZONE = 0.42;           // 点击位置在宠物高度该比例以上算摸头
const LEG_ZONE = 0.78;            // 点击位置在宠物高度该比例以下算戳腿
const LAND_IMPACT = 25;           // 落地速度超过该值时摔坐在地上
const DIZZY_IMPACT = 60;          // 落地速度超过该值时摔晕
const HUNGER_INTERVAL = 5 * 60 * 1000;   // 饱食度每隔多久下降 1 点（离线期间也会下降）
const HUNGRY_BELOW = 30;          // 饱食度低于该值时会饿
const FULL_ABOVE = 90;            // 饱食度高于该值时拒绝投喂
const SAD_BELOW = 20;             // 好感度低于该值时会委屈
const NEGLECT_AFTER = 24 * 3600 * 1000;  // 超过多久没互动，启动时委屈
const EDGE_DWELL = 1000;          // 鼠标在屏幕边缘停留多久后边缘偷看
const EDGE_COOLDOWN = 3000;       // 边缘偷看结束后多久内不再触发
const EDGE_SLIDE = 600;           // 边缘偷看滑出 / 缩回的时长
const EDGE_PEEK_MAX = 20 * 1000;  // 边缘偷看最长持续多久
const NEBULA_OPEN_AT = 1000;      // 钻入星云：戴上眼镜抬头时，星云开始从一个光点展开
const NEBULA_OPEN = 2500;         // 星云展开的时长
const NEBULA_DIVE = 1600;         // 缩小旋进星云核心的时长
const NEBULA_STAY = 3000;         // 在星云里玩的时长
const NEBULA_BACK = 1000;         // 从核心飞出来变回原大小的时长
const NEBULA_CLOSE_AT = 1500;     // 飞出来多久后（落地时）星云开始收拢
const NEBULA_CLOSE = 1200;        // 星云收拢的时长
const NEBULA_SPIN = 0.15;         // 星云旋转速度（弧度 / 秒）
const PROACTIVE_AFTER = 20 * 60 * 1000;  // 多久没聊天后主动搭话（实际在 1~2 倍之间随机）
// 启动时按时段问候：[起始小时, 结束小时, 动作, 台词事件]，不在这些时段内（深夜）时打哈欠
const GREETINGS = [
  [5, 10, 'stretch', 'greet_morning'],
  [10, 14, 'wave', 'greet_noon'],
  [14, 18, 'wave', 'greet_afternoon'],
  [18, 23, 'wave', 'greet_evening']
];
// 脱鞋后显示的光脚动作，没列出的动作都显示光脚坐着待机（barefoot）
const BAREFOOT_ACTIONS = {
  lie: 'barefoot_lie',
  read: 'barefoot_read',
  type: 'barefoot_type',
  drag: 'barefoot_drag',
  fall: 'barefoot_drag',
  takeoff: 'takeoff',
  puton: 'puton',
  // 边缘偷看看不到脚，光脚时照常
  edge_side: 'edge_side',
  edge_top: 'edge_top'
};
const images = {};                // url -> Image

let manifest = null;              // 为空时绘制占位小团子
let petSize = { width: 160, height: 160 };  // 宠物显示尺寸（逻辑像素），由主进程按体型档位换算
let config = {};
let state = 'idle';               // 动作名，见 manifest.json
let stateStart = performance.now();
let facing = 1;                   // 1 朝右，-1 朝左
let lastInteract = performance.now();
let chatting = false;
let replyText = '';
let bubbleTimer = null;
let ignoringMouse = true;
let downPos = null;
let dragging = false;
let manual = false;               // 手动播放的循环动作，持续到下次交互
let stats = {};                   // 养成数值，字段见 main.js 的 DEFAULT_STATS
let framePos = null;              // 跟随键盘时当前播放到的位置，为空时按时间播放
let frameTarget = 0;              // 跟随键盘时要推进到的位置
let lastFrameTime = performance.now();
let gaze = null;                  // 跟随鼠标时的视线 { x, y, tx, ty }，x 向右、y 向下，长度 0~1 对应正面到最大角度
let lastCursor = null;
let lastCursorMove = 0;
let lastKey = 0;
let edgePeek = null;              // 边缘偷看 { side, facing, pinned, start, leaving }，side 为 left / right / top，facing 为偷看前的朝向，pinned 为拖到边缘固定
let edgeDwell = null;             // 鼠标停在屏幕边缘 { side, since }
let edgeReadyAt = 0;              // 冷却结束时间
let nebula = null;                // 钻入星云 { size, start, dive, back }，size 为星云直径，其余为开始、旋进核心、飞出来的时间
let lines = {};                   // 各事件的台词，键为事件，值为台词数组，第 n 条对应语音 assets/voice/<事件>_<n>.mp3
let voice = null;                 // 正在播放的语音
let proactive = false;            // 当前这次聊天是否为主动搭话
let nextProactive = performance.now() + PROACTIVE_AFTER;  // 下次主动搭话的时间

function setState(next) {
  if (next === state) return;
  // 离开边缘偷看时回到原来的位置淡入，之后冷却一会儿
  if (edgePeek && !next.startsWith('edge_')) {
    facing = edgePeek.facing;
    edgePeek = null;
    edgeReadyAt = performance.now() + EDGE_COOLDOWN;
    petAPI.edge(null);
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], 300);
  }
  // 离开钻入星云时收起星云，恢复宠物画布和窗口
  if (nebula && !next.startsWith('nebula_')) {
    nebula = null;
    nebulaCanvas.width = nebulaCanvas.height = 0;
    canvas.style.transform = canvas.style.opacity = '';
    resizeHidden(() => petAPI.nebula(false));
  }
  // 释放上一个动作的帧，待机（脱鞋时连同光脚待机）作为兜底常驻，前后显示同一个动作时不释放
  const prevName = actionOf(state);
  const prev = manifest?.actions[prevName];
  if (prev && !['idle', actionOf('idle'), actionOf(next)].includes(prevName)) {
    [...(prev.frameUrls || [prev.sheetUrl]), ...(prev.flowUrls || [])].forEach(url => delete images[url]);
    prev.loading = null;
    prev.ready = false;
  }
  state = next;
  stateStart = performance.now();
  framePos = null;
  if (manifest?.actions[actionOf(next)]) {
    loadAction(actionOf(next)).catch(err => console.error(`[setState] load ${next} failed: ${err.message}`));
  }
}

// 有交互时重置睡眠计时，并唤醒
function wake() {
  lastInteract = performance.now();
  manual = false;
  if (['sleep', 'lie', 'read', 'hungry', 'sad'].includes(state)) setState('idle');
  stats.lastInteract = Date.now();
  petAPI.saveStats(stats);
}

function toggleInput(show) {
  inputBox.classList.toggle('hidden', !show);
  if (show) chatInput.focus();
}

function showBubble(text, isError) {
  clearTimeout(bubbleTimer);
  bubble.classList.remove('hidden');
  bubble.classList.toggle('error', !!isError);
  bubbleText.textContent = text;
}

function hideBubbleLater(ms) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms);
}

// 使用素材绘制当前动作帧，缺失的动作回退到 idle
function drawSprite(now) {
  let action = manifest.actions[actionOf(state)] || manifest.actions.idle;
  // 帧还在加载时先停在待机首帧（脱鞋时优先光脚待机），加载完从头播放
  if (!action.ready) {
    action = [actionOf('idle'), 'idle'].map(name => manifest.actions[name]).find(a => a.ready);
    stateStart = now;
  }
  const count = action.frameUrls ? action.frameUrls.length : action.count;
  let index = Math.max(0, Math.floor((now - stateStart) / 1000 * (action.fps || 8)));
  index = action.loop === false ? Math.min(index, count - 1) : index % count;
  // 跟随键盘时改为朝目标位置推进，速度与正常播放一致
  if (framePos !== null && action === manifest.actions[actionOf(state)]) {
    const step = (action.fps || 8) * (now - lastFrameTime) / 1000;
    framePos += Math.max(-step, Math.min(step, frameTarget - framePos));
    index = Math.round(framePos) % count;
  }
  // 跟随鼠标时视线平滑转向目标，按方向和幅度取相邻 4 帧，相邻方向之间按预计算光流变形，帧排列见 manifest 的 directions / steps
  let gazeDraw = null;
  if (state === 'gaze' && gaze && action === manifest.actions.gaze) {
    const k = Math.min(1, (now - lastFrameTime) / 120);
    gaze.x += (gaze.tx - gaze.x) * k;
    gaze.y += (gaze.ty - gaze.y) * k;
    const m = Math.min(1, Math.hypot(gaze.x, gaze.y)) * action.steps;
    const a = (Math.atan2(gaze.y, gaze.x) / (2 * Math.PI) * action.directions + action.directions) % action.directions;
    const m0 = Math.floor(m);
    const a0 = Math.floor(a);
    // 依次为 (a0, m0) (a0+1, m0) (a0, m0+1) (a0+1, m0+1)，幅度为 0 时是正面帧
    const frames = [[0, 0], [1, 0], [0, 1], [1, 1]]
      .map(([da, dm]) => [(a0 + da) % action.directions, Math.min(m0 + dm, action.steps)])
      .map(([ai, mi]) => mi && 1 + ai * action.steps + mi - 1);
    gazeDraw = { frames, fa: a - a0, fm: m - m0 };
  }
  const { width, height } = petSize;
  ctx.save();
  // 素材默认朝向与当前朝向不一致时水平翻转
  if (facing !== (manifest.facing === 'left' ? -1 : 1)) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  // 边缘偷看时从边缘滑出 / 缩回：素材往边缘外平移，超出画布（即屏幕边缘）的部分被裁掉，slide 为露出部分占画布的比例
  if (edgePeek && action === manifest.actions[state]) {
    const k = Math.min(1, Math.max(0, edgePeek.leaving ? 1 - (now - edgePeek.leaving) / EDGE_SLIDE : (now - edgePeek.start) / EDGE_SLIDE));
    const off = (1 - k) * (1 - k) * action.slide;
    ctx.translate(edgePeek.side === 'top' ? 0 : -off * width, edgePeek.side === 'top' ? -off * height : 0);
  }
  if (gazeDraw && gl && action.flowUrls) {
    // WebGL 先按幅度光流在两个方向上各自变形，再按方向光流在两个方向之间变形，结果画回主画布
    // 光流按文件名排序为 [帧 2 方向, 帧 2 幅度, 帧 3 方向, ...]；正面帧没有方向光流、已到最大幅度时没有幅度光流，用零光流
    const { frames, fa, fm } = gazeDraw;
    const flowUrls = [
      frames[0] && action.flowUrls[(frames[0] - 1) * 2],
      frames[2] && action.flowUrls[(frames[2] - 1) * 2],
      frames[2] !== frames[0] && action.flowUrls[(frames[2] - 1) * 2 + 1],
      frames[3] !== frames[1] && action.flowUrls[(frames[3] - 1) * 2 + 1]
    ];
    const flowImg = images[flowUrls.find(Boolean)];
    if (glCanvas.width !== canvas.width || glCanvas.height !== canvas.height) {
      glCanvas.width = canvas.width;
      glCanvas.height = canvas.height;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    [...frames.map(i => glTexture(action.frameUrls[i], false)), ...flowUrls.map(url => url ? glTexture(url, true) : glZeroFlow)]
      .forEach((tex, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      });
    gl.uniform1f(gl.getUniformLocation(glProgram, 't'), fa);
    gl.uniform1f(gl.getUniformLocation(glProgram, 'fm'), fm);
    gl.uniform2f(gl.getUniformLocation(glProgram, 'flowK'), 1 / (action.flowScale * manifest.width), 1 / (action.flowScale * manifest.height));
    if (flowImg) {
      const w = (flowImg.naturalWidth - 2) / 2;
      gl.uniform2f(gl.getUniformLocation(glProgram, 'flowW'), w / flowImg.naturalWidth, (w + 2) / flowImg.naturalWidth);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(glCanvas, 0, 0, width, height);
  } else if (gazeDraw) {
    // 不支持 WebGL 或没有光流时按权重叠加预乘颜色（画布已清空，等于逐像素加权平均）
    const { frames, fa, fm } = gazeDraw;
    ctx.globalCompositeOperation = 'lighter';
    [(1 - fm) * (1 - fa), (1 - fm) * fa, fm * (1 - fa), fm * fa].forEach((w, j) => {
      ctx.globalAlpha = w;
      ctx.drawImage(images[action.frameUrls[frames[j]]], 0, 0, width, height);
    });
  } else if (action.frameUrls) {
    ctx.drawImage(images[action.frameUrls[index]], 0, 0, width, height);
  } else {
    const img = images[action.sheetUrl];
    const cols = Math.floor(img.naturalWidth / action.frameWidth);
    const sx = (index % cols) * action.frameWidth;
    const sy = Math.floor(index / cols) * action.frameHeight;
    ctx.drawImage(img, sx, sy, action.frameWidth, action.frameHeight, 0, 0, width, height);
  }
  ctx.restore();
}

// 没有素材时用代码画一个会动的小团子
function drawPlaceholder(now) {
  const t = (now - stateStart) / 1000;
  let bob = Math.sin(now / 400) * 3;
  let sx = 1;
  let sy = 1;
  if (state === 'walk') bob = -Math.abs(Math.sin(t * 8)) * 8;
  if (state === 'happy') bob = -Math.abs(Math.sin(t * 10)) * 16;
  if (state === 'sleep') {
    bob = 0;
    sy = 1 + Math.sin(now / 900) * 0.04;
  }
  if (state === 'drag') {
    bob = 0;
    sx = 0.85;
    sy = 1.15;
  }
  const cx = 80;
  const baseY = 150;
  const rx = 62 * sx;
  const ry = 52 * sy;
  const cy = baseY - ry + bob;
  const lookX = state === 'walk' ? facing * 6 : 0;

  // 影子
  ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.beginPath();
  ctx.ellipse(cx, baseY + 4, 50 + bob, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // 身体
  const grad = ctx.createRadialGradient(cx - 20, cy - 25, 10, cx, cy, rx);
  grad.addColorStop(0, '#fff3c4');
  grad.addColorStop(1, '#ffc96b');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // 腮红
  ctx.fillStyle = 'rgba(255, 120, 120, 0.35)';
  ctx.beginPath();
  ctx.ellipse(cx - 38 + lookX, cy + 10, 10, 6, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 38 + lookX, cy + 10, 10, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // 眼睛
  ctx.fillStyle = ctx.strokeStyle = '#4a3b2a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const blink = state === 'idle' && now % 3500 < 150;
  const ey = cy - 6;
  for (const dx of [-22, 22]) {
    const ex = cx + dx + lookX;
    ctx.beginPath();
    if (state === 'sleep' || blink) {
      ctx.arc(ex, ey - 4, 7, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    } else if (state === 'happy') {
      ctx.arc(ex, ey + 4, 7, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
    } else {
      ctx.arc(ex, ey, state === 'drag' ? 7 : 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 嘴巴
  const my = cy + 14;
  ctx.beginPath();
  if (state === 'talk' && Math.floor(now / 150) % 2 === 0) {
    ctx.ellipse(cx + lookX, my + 2, 6, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (state === 'drag') {
    ctx.ellipse(cx, my + 2, 4, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.arc(cx + lookX, my - 3, 6, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  // 睡觉时飘 z
  if (state === 'sleep') {
    const p = (now % 2000) / 2000;
    ctx.globalAlpha = 1 - p;
    ctx.font = `bold ${14 + p * 8}px sans-serif`;
    ctx.fillText('z', cx + 45 + p * 12, cy - 35 - p * 30);
    ctx.globalAlpha = 1;
  }
}

function frame(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (manifest) {
    drawSprite(now);
    if (nebula) drawNebula(now);
  } else {
    drawPlaceholder(now);
  }
  lastFrameTime = now;
  requestAnimationFrame(frame);
}

// 鼠标在透明区域时穿透到桌面，在宠物/气泡/输入框上时可交互
window.addEventListener('mousemove', e => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  let ignore = !el || el === document.body || el === document.documentElement;
  // 宠物画布只在龙娘身上（像素不透明）可交互，四周的透明边距也穿透
  if (el === canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * canvas.width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * canvas.height);
    ignore = ctx.getImageData(x, y, 1, 1).data[3] < 32;
  }
  if (ignore !== ignoringMouse && !dragging && !downPos) {
    ignoringMouse = ignore;
    petAPI.setIgnoreMouse(ignore);
  }
});

// 按下后移动超过阈值算拖拽，否则算点击
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  downPos = { x: e.screenX, y: e.screenY };
});

canvas.addEventListener('pointermove', e => {
  if (!downPos || dragging) return;
  if (Math.hypot(e.screenX - downPos.x, e.screenY - downPos.y) > 4) {
    dragging = true;
    wake();
    // 先开始拖拽，从边缘偷看中拖出来时就不会回到原来的位置
    petAPI.dragStart();
    setState('drag');
    speak('drag');
  }
});

canvas.addEventListener('pointerup', async e => {
  if (!downPos) return;
  downPos = null;
  if (dragging) {
    // 松手后在空中保持 fall 状态，落地后由 pet:landed 恢复；在屏幕左、右、上边缘附近松手时固定在那里边缘偷看
    dragging = false;
    const side = await petAPI.dragEnd();
    if (side) {
      startEdgePeek(side, true);
      return;
    }
    setState('fall');
    return;
  }
  const asleep = state === 'sleep';
  wake();
  // 固定在边缘偷看时点击不回来，拖出来才回来
  if (edgePeek?.pinned) return;
  // 贴边偷看时被点击，先回到屏幕内
  petAPI.peek(false);
  // 点头部摸头、点腿部嫌弃，其余位置开心（聊天改为右键菜单进入）；睡着时被点醒说起床的台词
  const y = e.offsetY / petSize.height;
  if (!chatting && y < HEAD_ZONE) {
    const levelUp = updateStats(0, 1);
    playOnce('pat', levelUp ? 'love' : null);
    floatHearts(1);
    speak(asleep ? 'wake' : levelUp ? 'love' : 'pat');
    return;
  }
  if (!chatting && y > LEG_ZONE) {
    playOnce('dislike');
    speak(asleep ? 'wake' : 'dislike');
    return;
  }
  if (!chatting) {
    playOnce('happy');
    speak(asleep ? 'wake' : 'happy');
  }
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  petAPI.showContextMenu();
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') toggleInput(false);
  // isComposing 用于避免中文输入法选词时的回车误发送
  if (e.key !== 'Enter' || e.isComposing || !chatInput.value.trim()) return;
  petAPI.sendChat(chatInput.value.trim(), state);
  chatInput.value = '';
  toggleInput(false);
  wake();
  chatting = true;
  proactive = false;
  replyText = '';
  showBubble('……');
  speak('think', 0);
  setState('think');
});

bubble.addEventListener('dblclick', () => bubble.classList.add('hidden'));

window.addEventListener('blur', () => {
  if (!chatInput.value) toggleInput(false);
});

petAPI.on('chat:delta', delta => {
  // 收到第一个字前思考，开始回复后说话
  if (state === 'think') setState('talk');
  replyText += delta;
  showBubble(replyText);
  bubbleText.scrollTop = bubbleText.scrollHeight;
});

petAPI.on('chat:done', () => {
  chatting = false;
  nextProactive = performance.now() + PROACTIVE_AFTER * (1 + Math.random());
  // 主动搭话时模型决定不说话
  if (proactive && !replyText) {
    proactive = false;
    return;
  }
  lastInteract = performance.now();
  // 聊天加好感度（主动搭话不加），升级时比心；正在播模型选的动作时不打断
  if (!proactive && updateStats(0, 2)) {
    playOnce('love');
  } else if (['talk', 'think'].includes(state)) {
    setState('idle');
  }
  proactive = false;
  hideBubbleLater(5000 + replyText.length * 150);
});

petAPI.on('chat:error', message => {
  chatting = false;
  nextProactive = performance.now() + PROACTIVE_AFTER * (1 + Math.random());
  // 主动搭话失败时不打扰
  if (proactive) {
    proactive = false;
    return;
  }
  setState('idle');
  showBubble(message, true);
  hideBubbleLater(6000);
});

petAPI.on('pet:landed', impact => {
  // 摔得重时摔坐在地上再站起来，特别重时再晕一会儿
  if (['drag', 'fall'].includes(state)) {
    if (impact > LAND_IMPACT) {
      playOnce('land', impact > DIZZY_IMPACT ? 'dizzy' : null);
      speak('dizzy');
    } else {
      setState('idle');
      speak('land');
    }
  }
  // 固定在 GPT 里时，落地后回到 ChatGPT 窗口范围内
  petAPI.peek(false);
});

// 右键菜单手动播放动作：一次性动作播完回到待机，循环动作持续到下次交互
petAPI.on('pet:play', name => {
  wake();
  petAPI.peek(false);
  speak(name);
  if (manifest?.actions[name]?.loop === false) {
    playOnce(name);
    return;
  }
  setState(name);
  manual = true;
  if (name === 'peek' && !config.pinGPT) petAPI.peek(true);
});

petAPI.on('pet:open-input', () => {
  wake();
  toggleInput(true);
});

petAPI.on('pet:resize', size => {
  petSize = size;
  resizeCanvas();
});

petAPI.on('config:changed', newConfig => {
  config = newConfig;
  if (!config.walkEnabled && state === 'walk') setState('idle');
  if (!config.gazeEnabled && state === 'gaze') setState('idle');
  if ((!config.edgePeekEnabled || config.pinGPT) && edgePeek) setState('idle');
});

// 行为决策：每秒一次，决定走动、停下、偷看、躺下、读书、饿了、委屈或睡觉
setInterval(() => {
  if (manual || chatting || dragging || ['drag', 'fall', 'happy', 'talk', 'think', 'pat', 'dislike', 'jump', 'land', 'dizzy', 'look',
    'gaze', 'wave', 'stretch', 'yawn', 'eat', 'refuse', 'love', 'edge_side', 'edge_top'].includes(state) || !inputBox.classList.contains('hidden')) return;
  // 停止打字一会儿后回到待机
  if (state === 'type') {
    if (performance.now() - lastKey > 2000) setState('idle');
    return;
  }
  if (state === 'walk') {
    if (Math.random() < 0.15) setState('idle');
    return;
  }
  // 偷看一会儿后朝屏幕内走回来
  if (state === 'peek') {
    if (Math.random() < 0.1) setState('walk');
    return;
  }
  if (performance.now() - lastInteract > SLEEP_AFTER) {
    if (state !== 'sleep' && bubble.classList.contains('hidden')) speak('sleep');
    setState('sleep');
    return;
  }
  if (['lie', 'read', 'hungry', 'sad'].includes(state)) {
    if (Math.random() < 0.05) setState('idle');
    return;
  }
  if (state !== 'idle') return;
  const r = Math.random();
  const hour = new Date().getHours();
  if (config.walkEnabled && !stats.barefoot && r < 0.08) {
    facing = Math.random() < 0.5 ? -1 : 1;
    setState('walk');
  } else if (r < 0.11) {
    playOnce('jump');
  } else if (r < 0.16) {
    setState('lie');
  } else if (r < 0.21) {
    setState('read');
  } else if (stats.hunger < HUNGRY_BELOW && r < 0.26) {
    setState('hungry');
    if (bubble.classList.contains('hidden')) speak('hungry');
  } else if (stats.favor < SAD_BELOW && r >= 0.26 && r < 0.29) {
    setState('sad');
    if (bubble.classList.contains('hidden')) speak('sad');
  } else if ((hour >= 23 || hour < 5) && r >= 0.29 && r < 0.292) {
    playOnce('yawn');
    if (bubble.classList.contains('hidden')) speak('yawn');
  }
}, 1000);

// 走动时持续移动窗口，碰到屏幕边缘掉头，有一定概率贴边偷看（固定在 GPT 里时不偷看）
setInterval(async () => {
  if (state !== 'walk') return;
  const { hitEdge } = await petAPI.moveBy(facing * (manifest?.walkSpeed || 2));
  if (!hitEdge) return;
  facing = -facing;
  if (!config.pinGPT && Math.random() < 0.5) {
    setState('peek');
    petAPI.peek(true);
    speak('peek');
  }
}, 33);

(async () => {
  config = await petAPI.getConfig();
  ({ manifest, petSize, lines } = await petAPI.getAssets());
  stats = await petAPI.getStats();
  if (manifest) {
    try {
      // 启动时只加载待机（脱鞋时连同光脚待机），其余动作切换时按需加载
      await Promise.all([loadAction('idle'), loadAction(actionOf('idle'))]);
    } catch (err) {
      console.error(`[init] load sprite failed, use placeholder: ${err.message}`);
      manifest = null;
    }
  }
  resizeCanvas();
  requestAnimationFrame(frame);
  // 离线期间饱食度照常下降
  const now = Date.now();
  updateStats(-(now - (stats.updatedAt || now)) / HUNGER_INTERVAL, 0);
  // 很久没理她时委屈地等着，直到有互动；否则按时段问候
  if (now - (stats.lastInteract || now) > NEGLECT_AFTER) {
    setState('sad');
    manual = true;
    speak('miss_you', 5000);
  } else {
    const hour = new Date().getHours();
    const [, , action, event] = GREETINGS.find(([from, to]) => hour >= from && hour < to) || [0, 0, 'yawn', 'greet_night'];
    playOnce(action);
    speak(event, 5000);
  }
})();

// 按宠物显示尺寸设置画布，画布按物理像素分配，避免高 DPI 下发糊
function resizeCanvas() {
  const { width, height } = petSize;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);
  // 像素风素材关闭平滑，避免放大后发糊
  ctx.imageSmoothingEnabled = !manifest?.pixelArt;
  ctx.imageSmoothingQuality = 'high';
}

// 播放一次性动作，播完播放 next（同样只播一次），没有 next 时回到待机
function playOnce(name, next) {
  setState(name);
  const action = manifest?.actions[name];
  const ms = action ? (action.frameUrls?.length || action.count) / (action.fps || 8) * 1000 : 1200;
  // 从帧加载完成开始计时，避免加载耗时吃掉播放时长
  const loaded = action ? loadAction(name).catch(() => {}) : Promise.resolve();
  loaded.then(() => setTimeout(() => {
    if (state !== name) return;
    if (next) {
      playOnce(next);
    } else {
      setState('idle');
    }
  }, ms));
}

// 按需加载动作的帧，返回加载完成的 Promise，重复调用复用同一次加载
function loadAction(name) {
  const action = manifest.actions[name];
  if (action.loading) return action.loading;
  const urls = [...(action.frameUrls || [action.sheetUrl]), ...(action.flowUrls || [])];
  const loading = Promise.all(urls.map(url => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = () => reject(new Error(`load ${url} failed`));
    img.src = url;
    images[url] = img;
  }))).then(() => {
    // 加载期间已切走并被释放的，不标记为就绪
    if (action.loading === loading) action.ready = true;
  });
  action.loading = loading;
  return loading;
}

// 饱食度随时间下降，饿肚子时好感度也慢慢下降
setInterval(() => updateStats(-1, stats.hunger > 0 ? 0 : -1), HUNGER_INTERVAL);

// 开启跟着打字时，每按一次键推进几帧敲键盘动作，停手后由行为决策回到待机
petAPI.on('pet:key', count => {
  if (!manifest?.actions.type || manual || chatting || dragging || !['idle', 'gaze', 'type', 'lie', 'read', 'hungry', 'sad', 'sleep'].includes(state)) return;
  if (state !== 'type') {
    setState('type');
    framePos = frameTarget = 0;
  }
  // 最多领先半秒，停手后很快停下
  frameTarget = Math.min(frameTarget + count * 8, framePos + 30);
  lastKey = lastInteract = performance.now();
});

// 鼠标在附近移动时看向鼠标：按鼠标相对头部的方向和距离取 gaze 的帧，鼠标停下 3 秒或离远后回到待机
setInterval(async () => {
  if (!manifest?.actions.gaze || !config.gazeEnabled || stats.barefoot || manual || chatting || !['idle', 'gaze'].includes(state)) return;
  const p = await petAPI.getCursor();
  if (!['idle', 'gaze'].includes(state)) return;
  const now = performance.now();
  if (lastCursor && (p.x !== lastCursor.x || p.y !== lastCursor.y)) lastCursorMove = now;
  lastCursor = p;
  // 以头部（宠物顶部往下 30%）为原点，按宠物尺寸归一化
  const dx = (p.x - window.innerWidth / 2) / petSize.width;
  const dy = (p.y - window.innerHeight + petSize.height * 0.7) / petSize.height;
  const dist = Math.hypot(dx, dy);
  if (dist > 4 || now - lastCursorMove > 3000) {
    if (state === 'gaze') setState('idle');
    return;
  }
  if (state === 'idle') {
    setState('gaze');
    gaze = { x: 0, y: 0 };
  }
  // 素材翻转时左右互换，鼠标离头部 1.5 个身位以上时转到最大角度
  const flipped = facing !== (manifest.facing === 'left' ? -1 : 1);
  const scale = Math.min(1, dist / 1.5) / (dist || 1);
  gaze.tx = dx * scale * (flipped ? -1 : 1);
  gaze.ty = dy * scale;
}, 50);

// 边缘偷看：鼠标在屏幕左、右、上边缘停留一会儿时，原地淡出，再从鼠标旁边的那条边滑出来偷看（右边缘水平翻转）
// 鼠标走远或看够了缩回去，回到原来的位置；固定在 GPT 里时不偷看
setInterval(async () => {
  if (!manifest?.actions.edge_side || !manifest.actions.edge_top) return;
  const p = await petAPI.getCursor();
  const now = performance.now();
  if (edgePeek) {
    // 鼠标离画布中心超过 1.5 个身位
    const far = Math.hypot(p.x - window.innerWidth / 2, p.y - window.innerHeight + petSize.height / 2) > petSize.width * 1.5;
    if (state.startsWith('edge_') && !edgePeek.leaving && !edgePeek.pinned && (far || now - edgePeek.start > EDGE_PEEK_MAX)) {
      const peek = edgePeek;
      peek.leaving = now;
      setTimeout(() => peek === edgePeek && setState('idle'), EDGE_SLIDE);
    }
    return;
  }
  const side = p.edges && ['left', 'right', 'top'].find(k => p.edges[k] <= 1);
  if (side !== edgeDwell?.side) edgeDwell = side ? { side, since: now } : null;
  if (!edgeDwell || now - edgeDwell.since < EDGE_DWELL || now < edgeReadyAt || !config.edgePeekEnabled || config.pinGPT || manual || chatting || dragging
    || !inputBox.classList.contains('hidden') || !['idle', 'gaze', 'walk', 'lie', 'read', 'hungry', 'sad', 'sleep'].includes(state)) return;
  edgeDwell = null;
  startEdgePeek(side, false);
}, 100);

// 投喂：食物从头顶掉到手里再吃，吃饱了拒绝，讨厌的食物嫌弃，好感度升级时吃完比心
petAPI.on('pet:feed', food => {
  if (chatting || dragging) return;
  wake();
  petAPI.peek(false);
  if (!food.dislike && stats.hunger > FULL_ABOVE) {
    playOnce('refuse');
    speak('full', 3000);
    return;
  }
  // 下落途中不被行为决策打断
  manual = true;
  setState('idle');
  const size = petSize.width * 0.2;
  foodImg.src = `../assets/pet/icons/food_${food.name}.png`;
  foodImg.style.width = `${size}px`;
  foodImg.classList.remove('hidden');
  foodImg.animate([
    { transform: 'translate(-50%, 0)' },
    { transform: `translate(-50%, ${window.innerHeight - petSize.height * 0.45 - size / 2}px)` }
  ], { duration: 700, easing: 'ease-in', fill: 'forwards' }).finished.then(() => {
    foodImg.classList.add('hidden');
    manual = false;
    const levelUp = updateStats(food.hunger, food.favor);
    if (food.dislike) {
      playOnce('dislike');
      speak(`eat_${food.name}`, 3000);
    } else {
      // 有该食物专属的吃东西动作（eat_<名称>）时用专属动作
      playOnce(manifest?.actions[`eat_${food.name}`] ? `eat_${food.name}` : 'eat', levelUp ? 'love' : null);
      floatHearts(2);
      speak(levelUp ? 'love' : `eat_${food.name}`, 3000);
    }
  });
});

// 修改饱食度和好感度并存档，返回好感度是否升级，升级时飘出一串爱心
function updateStats(hunger, favor) {
  const level = Math.floor(stats.favor / 100);
  stats.hunger = Math.min(100, Math.max(0, stats.hunger + hunger));
  stats.favor = Math.max(0, stats.favor + favor);
  stats.updatedAt = Date.now();
  petAPI.saveStats(stats);
  const levelUp = Math.floor(stats.favor / 100) > level;
  if (levelUp) floatHearts(5);
  return levelUp;
}

// 从头顶飘出爱心
function floatHearts(count) {
  for (let i = 0; i < count; i++) {
    const heart = document.createElement('img');
    heart.src = '../assets/pet/icons/status_heart.png';
    heart.className = 'heart';
    heart.style.width = `${petSize.width * 0.12}px`;
    heart.style.left = `${window.innerWidth / 2 + (Math.random() - 0.5) * petSize.width * 0.4}px`;
    heart.style.top = `${window.innerHeight - petSize.height * 0.9}px`;
    document.body.append(heart);
    heart.animate([
      { transform: 'translate(-50%, 0)', opacity: 1 },
      { transform: `translate(-50%, ${-petSize.height * 0.3}px)`, opacity: 0 }
    ], { duration: 1500, delay: i * 200, easing: 'ease-out', fill: 'both' }).finished.then(() => heart.remove());
  }
}

// 脱鞋 / 穿鞋：脱鞋后一直光脚（重启也保持），直到再选穿鞋；先加载好帧再切换，避免中途闪回另一种待机
petAPI.on('pet:shoes', () => {
  if (chatting || dragging) return;
  wake();
  petAPI.peek(false);
  // 加载期间不被行为决策打断
  manual = true;
  const name = stats.barefoot ? 'puton' : 'takeoff';
  Promise.all([loadAction(name), loadAction(stats.barefoot ? 'idle' : 'barefoot')]).then(() => {
    manual = false;
    stats.barefoot = !stats.barefoot;
    petAPI.saveStats(stats);
    playOnce(name);
    speak(name);
  });
});

// 动作实际显示的素材：脱鞋时换成对应的光脚动作，脱白丝时再换成光腿动作，素材里没有时用原动作
function actionOf(name) {
  let shown = stats.barefoot ? BAREFOOT_ACTIONS[name] || 'barefoot' : name;
  // 脱白丝后换成对应的光腿动作（barefoot_* -> bare_*）
  if (stats.bare) shown = shown.replace('barefoot', 'bare');
  return manifest?.actions[shown] ? shown : name;
}

// 视线跟随用 WebGL 按预计算光流变形混合相邻方向的帧（见 scripts/build-gaze-flow.py），结果再画到主画布上；不支持 WebGL 时回退为淡入淡出
const GL_TEXTURE_LIMIT = 24;      // 最多保留的纹理数，约 3MB 一张
const glCanvas = document.createElement('canvas');
const gl = glCanvas.getContext('webgl', { premultipliedAlpha: true });
const glTextures = new Map();     // url -> 纹理，按最近使用排序
let glProgram = null;
let glZeroFlow = null;            // 零光流（遮罩 0.5），用于正面帧没有方向光流、最大幅度没有幅度光流时
if (gl) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, `
    attribute vec2 pos;
    varying vec2 uv;
    void main() {
      uv = vec2(pos.x, -pos.y) * 0.5 + 0.5;
      gl_Position = vec4(pos, 0.0, 1.0);
    }`);
  // 光流图左半为 (中间 -> 前一帧光流, 遮罩)，右半为 (中间 -> 后一帧光流)，按比例线性缩放光流后变形两帧，再按遮罩混合
  // 两帧透明度差别大的地方（耳朵、发饰被挡住又露出）按差别把混合权重压陡，缩短半透明的时间
  // frame0~3 依次为 (a0, m0) (a0+1, m0) (a0, m0+1) (a0+1, m0+1)；dir0/dir1 为 m0、m0+1 两行的方向光流，mag0/mag1 为 a0、a0+1 两列的幅度光流
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, `
    precision highp float;
    varying vec2 uv;
    uniform sampler2D frame0, frame1, frame2, frame3, dir0, dir1, mag0, mag1;
    uniform float t, fm;
    uniform vec2 flowK, flowW;
    vec3 front(sampler2D f, vec2 p) {
      vec3 v = texture2D(f, vec2(p.x * flowW.x, p.y)).rgb;
      return vec3((v.rg * 255.0 - 128.0) * flowK, v.b);
    }
    vec2 back(sampler2D f, vec2 p) {
      return (texture2D(f, vec2(flowW.y + p.x * flowW.x, p.y)).rg * 255.0 - 128.0) * flowK;
    }
    float weight(float s, float m) {
      return (1.0 - s) * m / ((1.0 - s) * m + s * (1.0 - m) + 1e-6);
    }
    vec4 blend(vec4 b, vec4 a, float w) {
      return mix(b, a, mix(w, smoothstep(0.4, 0.6, w), abs(a.a - b.a)));
    }
    vec4 morph(sampler2D a, sampler2D b, sampler2D f, vec2 p, float s) {
      vec3 x = front(f, p);
      vec4 wa = texture2D(a, p + x.xy * s * 2.0);
      vec4 wb = texture2D(b, p + back(f, p) * (1.0 - s) * 2.0);
      return blend(wb, wa, weight(s, x.z));
    }
    void main() {
      vec3 x = mix(front(dir0, uv), front(dir1, uv), fm);
      vec2 y = mix(back(dir0, uv), back(dir1, uv), fm);
      vec4 wa = morph(frame0, frame2, mag0, uv + x.xy * t * 2.0, fm);
      vec4 wb = morph(frame1, frame3, mag1, uv + y * (1.0 - t) * 2.0, fm);
      gl_FragColor = blend(wb, wa, weight(t, x.z));
    }`);
  glProgram = gl.createProgram();
  [vs, fs].forEach(shader => {
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(`[gl] compile shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(glProgram, shader);
  });
  gl.linkProgram(glProgram);
  gl.useProgram(glProgram);
  ['frame0', 'frame1', 'frame2', 'frame3', 'dir0', 'dir1', 'mag0', 'mag1'].forEach((name, unit) => gl.uniform1i(gl.getUniformLocation(glProgram, name), unit));
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(glProgram, 'pos');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  glZeroFlow = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glZeroFlow);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
}

// 取图片对应的纹理，没有时上传：帧按预乘 alpha 上传，光流按原始字节上传；超出上限时删掉最久没用的
function glTexture(url, isFlow) {
  let tex = glTextures.get(url);
  if (tex) {
    glTextures.delete(url);
  } else {
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !isFlow);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, isFlow ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[url]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (glTextures.size >= GL_TEXTURE_LIMIT) {
      const [oldUrl, oldTex] = glTextures.entries().next().value;
      gl.deleteTexture(oldTex);
      glTextures.delete(oldUrl);
    }
  }
  glTextures.set(url, tex);
  return tex;
}

// 边缘偷看：原地淡出的同时加载好帧，再从 side 那条边滑出来（右边缘水平翻转）；pinned 为拖到边缘松手时，固定在那里不会自己缩回去
// 淡出期间不被行为决策打断，有交互时取消（固定时不取消，否则会停在半空）；睡着时也会醒来偷看，回来后过一会儿再睡
async function startEdgePeek(side, pinned) {
  const name = side === 'top' ? 'edge_top' : 'edge_side';
  lastInteract = performance.now();
  manual = true;
  const fade = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
  await Promise.all([fade.finished, loadAction(name).catch(() => {})]);
  if (dragging || (!manual && !pinned)) {
    fade.cancel();
    return;
  }
  manual = false;
  edgePeek = { side, facing, pinned, start: performance.now(), leaving: 0 };
  facing = side === 'right' ? -1 : 1;
  petAPI.edge(side, pinned);
  setState(name);
  speak('peek');
  fade.cancel();
}

// 脱白丝 / 穿白丝：只在光脚时可用，脱下的白丝塞在靴子里，一直光腿（重启也保持），直到再选穿白丝
// 脱 / 穿的过程不做动画（视频模型一动腿就会屈膝露出裙底），淡出后换成另一种待机再淡入
petAPI.on('pet:stockings', () => {
  if (chatting || dragging || !stats.barefoot) return;
  wake();
  petAPI.peek(false);
  // 加载期间不被行为决策打断
  manual = true;
  const fade = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
  Promise.all([fade.finished, loadAction(stats.bare ? 'barefoot' : 'bare')]).then(() => {
    manual = false;
    stats.bare = !stats.bare;
    petAPI.saveStats(stats);
    setState('idle');
    fade.cancel();
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], 300);
  });
});

// 钻入星云：戴上眼镜望见身后展开的星云，跃起后缩小旋进星云核心，在里面玩一会儿，再从核心飞出来落地，星云收拢
// 窗口临时放大放得下星云，先加载好帧再开始；中途有交互（切到其他动作）时中止，由 setState 收起星云
petAPI.on('pet:nebula', async () => {
  if (chatting || dragging || nebula || stats.barefoot) return;
  wake();
  petAPI.peek(false);
  setState('idle');
  // 加载期间不被行为决策打断
  manual = true;
  nebulaImg.src = '../assets/pet/nebula.webp';
  try {
    await Promise.all([loadAction('nebula_in'), loadAction('nebula_fly'), loadAction('nebula_out'), nebulaImg.decode()]);
  } catch (err) {
    console.error(`[pet:nebula] load failed: ${err.message}`);
    manual = false;
    return;
  }
  if (!manual || dragging || state !== 'idle') return;
  const run = nebula = { size: await resizeHidden(() => petAPI.nebula(true)), start: performance.now(), dive: 0, back: 0 };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const duration = name => manifest.actions[name].frameUrls.length / manifest.actions[name].fps * 1000;
  // 星云动作和旋进弧线都按素材默认朝向设计，走动后朝向可能是反的，先转回来
  facing = manifest.facing === 'left' ? -1 : 1;
  setState('nebula_in');
  speak('nebula_in');
  await wait(duration('nebula_in'));
  if (nebula !== run) return;
  run.dive = performance.now();
  setState('nebula_fly');
  await wait(NEBULA_DIVE + NEBULA_STAY);
  if (nebula !== run) return;
  run.back = performance.now();
  setState('nebula_out');
  speak('nebula_out');
  await wait(duration('nebula_out'));
  if (nebula !== run) return;
  manual = false;
  setState('idle');
});

// 画钻入星云：星云以宠物画布顶边中点为中心展开、旋转、收拢，身后垫一层深色光晕，旋进 / 飞出核心时核心闪光
// 同时按阶段变换宠物画布：飞向核心时沿弧线越飞越远、淡出，在星云里时隐藏，飞出来时从核心由小变大
function drawNebula(now) {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (nebulaCanvas.width !== Math.round(w * dpr) || nebulaCanvas.height !== Math.round(h * dpr)) {
    nebulaCanvas.width = Math.round(w * dpr);
    nebulaCanvas.height = Math.round(h * dpr);
  }
  const c = nebulaCtx;
  const cx = w / 2;
  const cy = h - petSize.height;
  const t = now - nebula.start;
  const ease = x => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  // 展开 / 收拢的进度
  let k = ease((t - NEBULA_OPEN_AT) / NEBULA_OPEN);
  if (nebula.back) k = Math.min(k, 1 - ease((now - nebula.back - NEBULA_CLOSE_AT) / NEBULA_CLOSE));
  const r = nebula.size / 2 * k;
  if (r > 0) {
    c.translate(cx, cy);
    // 深色光晕，浅色桌面上也像在太空里
    const glow = c.createRadialGradient(0, 0, 0, 0, 0, r);
    glow.addColorStop(0, 'rgba(12, 6, 32, 0.75)');
    glow.addColorStop(0.7, 'rgba(12, 6, 32, 0.5)');
    glow.addColorStop(1, 'rgba(12, 6, 32, 0)');
    c.fillStyle = glow;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = k;
    c.rotate(-t / 1000 * NEBULA_SPIN);
    c.drawImage(nebulaImg, -r, -r, r * 2, r * 2);
    // 再叠一层稍大、反向慢转的星云，旋臂看起来在流动
    c.rotate(t / 1000 * NEBULA_SPIN * 1.6);
    c.globalAlpha = k * 0.3;
    c.globalCompositeOperation = 'lighter';
    c.drawImage(nebulaImg, -r * 1.1, -r * 1.1, r * 2.2, r * 2.2);
    // 核心闪光：旋进核心时、飞出来时各闪一下
    const flash = Math.max(0, ...[nebula.dive && nebula.dive + NEBULA_DIVE, nebula.back].filter(Boolean).map(at => 1 - Math.abs(now - at) / 400));
    if (flash > 0) {
      const core = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.4);
      core.addColorStop(0, 'rgba(255, 255, 255, 1)');
      core.addColorStop(0.3, 'rgba(240, 210, 255, 0.6)');
      core.addColorStop(1, 'rgba(200, 160, 255, 0)');
      c.globalAlpha = flash;
      c.fillStyle = core;
      c.beginPath();
      c.arc(0, 0, r * 0.4, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  // 核心在画布中心正上方半个画布高处
  const coreY = -petSize.height / 2;
  let transform = '';
  let opacity = '';
  if (nebula.back) {
    const p = ease((now - nebula.back) / NEBULA_BACK);
    transform = `translateY(${coreY * (1 - p)}px) scale(${0.05 + 0.95 * p})`;
    opacity = Math.min(1, (now - nebula.back) / 300);
  } else if (nebula.dive) {
    // 不打转，按透视往远处飞：离镜头的距离逐渐加速变远，大小随距离变小，位置随之收向核心；
    // 途中向右划一道弧线再回到核心，身体顺着飞行方向微微倾斜
    const p = Math.min(1, Math.max(0, (now - nebula.dive) / NEBULA_DIVE));
    const scale = 1 / (1 + 19 * (0.3 * p + 0.7 * p * p));
    const q = (1 - scale) / 0.95;
    transform = `translate(${Math.sin(q * Math.PI) * petSize.width * 0.2}px, ${coreY * q}px) rotate(${Math.cos(q * Math.PI) * 12}deg) scale(${scale})`;
    opacity = 1 - Math.max(0, (p - 0.7) / 0.3);
  }
  canvas.style.transform = transform;
  canvas.style.opacity = opacity;
}

// 窗口改尺寸的瞬间屏幕上会先显示一帧贴在新窗口左上角的旧画面，宠物看起来会闪到别处：
// 先隐藏宠物画布、等不含宠物的一帧显示出来再改尺寸，等新尺寸布局画出来后再显示
async function resizeHidden(resize) {
  const [w, h] = [innerWidth, innerHeight];
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  canvas.style.visibility = 'hidden';
  await nextFrame();
  const result = await resize();
  for (let i = 0; i < 30 && innerWidth === w && innerHeight === h; i++) await nextFrame();
  await nextFrame();
  canvas.style.visibility = '';
  return result;
}

// 说一句台词：从该事件的台词里随机挑一条，气泡显示同一句，hideAfter 毫秒后收起（为 0 时不收起），开了语音时同时播放语音
// 上一句语音还没播完时不打断，这一句不说；隐藏时或没有该事件的台词时什么都不做
function speak(event, hideAfter = 4000) {
  const texts = lines[event];
  if (!texts || document.hidden || (config.voiceEnabled && voice && !voice.paused)) return;
  const index = Math.floor(Math.random() * texts.length);
  showBubble(texts[index]);
  if (hideAfter > 0) hideBubbleLater(hideAfter);
  voice?.pause();
  voice = null;
  if (!config.voiceEnabled) return;
  voice = new Audio(`../assets/voice/${event}_${index + 1}.mp3`);
  voice.volume = config.voiceVolume / 100;
  voice.play().catch(err => console.error(`[speak] play voice failed: ${err.message}`));
}

// 模型在回复开头选的动作：躺下、读书等休息类动作由行为决策或下次交互结束，其余播一次
petAPI.on('chat:action', name => {
  if (!manifest?.actions[name]) return;
  if (['sleep', 'lie', 'read', 'hungry', 'sad'].includes(name)) {
    setState(name);
  } else {
    playOnce(name);
  }
});

// 主动搭话：很久没聊天时，她空闲着、没在说话就让模型按人设决定要不要主动说一句（你离开电脑时由主进程跳过）
setInterval(() => {
  if (!config.proactiveEnabled || performance.now() < nextProactive || chatting || dragging || manual || document.hidden
    || !inputBox.classList.contains('hidden') || !bubble.classList.contains('hidden')
    || !['idle', 'gaze', 'walk', 'lie', 'read', 'hungry', 'sad', 'sleep'].includes(state)) return;
  chatting = proactive = true;
  replyText = '';
  petAPI.sendChat('', state);
}, 1000);
