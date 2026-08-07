// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.6.2
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。双算法协同：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）。v0.6.2：DomainBlockExecutor统一域名封杀、积木条件匹配/正则文本遍历抽取共享方法、网络拦截扩展至Image/Link/Media/WebSocket/sendBeacon、ResourceSelectorBuilder统一选择器构建、BlockEngine.hideElement/showElement统一隐藏口径。
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
