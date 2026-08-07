// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.7.1
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。双算法协同：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）。v0.7.1：修复8面板审查报告隐藏BUG——正则合并捕获组错位(内层()转非捕获)/导航拦截快照过期(实时读getDomainSet)/路径自动提取死代码(addUrl放行相对路径)/影响度评估ReDoS(补isRegexSafe预检)/DomainBlockExecutor批量applyCSSRules/AdGuard导出\/二次转义/深度扫描后自动勾选新高分域名/regex-level NaN兜底/startSelection retry回调补齐。
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
