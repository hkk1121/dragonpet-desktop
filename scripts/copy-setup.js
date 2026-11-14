// electron-builder 打包完成后执行（package.json 的 build.afterAllArtifactBuild）：
// 把安装包另复制一份到上一级目录，按发布时的显示名命名为 GPT小龙娘桌面版-v<版本号>.exe
const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

exports.default = function copySetup(buildResult) {
  const setup = buildResult.artifactPaths.find(p => path.basename(p) === `GPT-DragonPet-Desktop-Setup-${version}.exe`);
  if (setup) {
    const dest = path.join(__dirname, '..', '..', `GPT小龙娘桌面版-v${version}.exe`);
    fs.copyFileSync(setup, dest);
    console.log(`[copySetup] installer copied to ${dest}`);
  }
  // 不额外发布文件
  return [];
};
