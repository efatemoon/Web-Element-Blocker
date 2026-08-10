// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.8.1
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。双算法协同：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）。v0.8.0：新增动态 iframe 广告拦截完整防线——IframeGuard（创建拦截+递归分类扫描）、ContentClassifier（正文分/广告分评分体系，正文保护铁律）、FrameMessenger（postMessage 跨域帧间通信协议）、MessageGuard（可疑消息监控）、WhitelistStore（iframe 白名单保护）、EventBus（模块解耦）；新增 iframeBlock/iframeWhitelist 规则类型；NetworkInterceptor 增加 iframe src 拦截；管理面板新增 iframe 统计看板/白名单管理/规则添加/扫描深度设置；导出/导入/AdGuard 导出支持 iframe 规则桶。
// @author       EFate
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/web-element-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/web-element-blocker.meta.js
// ==/UserScript==
