// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.7.0
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。双算法协同：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）。v0.7.0：重构真·深度扫描——覆盖层新增Canvas肤色采样/CSS伪元素穿透/混淆跳转沙箱解码/Icon Font映射检测，全局域名新增ServiceWorker/WebSocket/Blob URL/CSS伪元素/SVG引用溯源；区分"重新扫描"(快速基线)与"深度扫描"(高阶探测)；修复BUG-1~4(影响度排序跳过禁用规则/触摸事件DOM校验/e.currentTarget/双引擎补齐)、不一致-1~3(removeRule统一reapplyAll/去除冗余applyCSSRules/区分基线与深度)、冗余-1~3(移除被覆盖的restoreInlineForDomain/批量拦截applyCSSRules改单次/线性查找改Map/Set O(1))。
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
