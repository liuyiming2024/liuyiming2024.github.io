/* Cloud Drive · 配置
 * 公开仓库（Cloud）里只出现它自己的仓库名。
 * 私有存储库的名字与地址不写在这里，也不写进任何前端文件——
 * 它由 Actions 侧的 Secrets 持有，页面永远拿不到。
 */
window.CloudCfg = {
  // 页面所在的公开仓库（Pages 站点本身）
  owner: 'liuyiming2024',
  repo: 'Cloud',

  // 搬运工作流。页面只会触发它，不会也不该知道它把文件搬到哪
  workflow: 'drive.yml',

  // 暂存区路径（都在公开仓库内，内容一律是密文）
  inbox: 'inbox',    // 上传：页面写 → Actions 取走
  outbox: 'outbox',  // 下载：Actions 放 → 页面取走
  status: 'status',  // 任务回执

  // 上传专用 token 存在浏览器本地，key 名
  tokenKey: 'cloud_drive_token',

  crypto: {
    // PBKDF2 迭代次数。改了会导致旧文件解不开
    iterations: 250000,
    chunkSize: 4 * 1024 * 1024 // 分块 4MB，避免大文件一次性进内存
  },

  // 超过这个字节走 Release 通道（由 Actions 侧决定，这里只用于提示）
  bigFileHint: 50 * 1024 * 1024
};
