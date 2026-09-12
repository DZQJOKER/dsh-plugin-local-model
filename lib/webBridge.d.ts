import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { Log } from './log.js';
import type { LocalModelRuntime } from './lifecycle.js';
import type { ConfigStore } from './configStore.js';
import type { FormDescriptor } from './schemaForm.js';
/** 同源路由前缀。浏览器侧直接 fetch 相对路径，不跨端口、不需要 CORS。 */
export declare const BRIDGE_PREFIX = "/api/local-model";
/** 宿主 webServer 服务里我们用到的那一小部分。 */
export interface WebServerLike {
    readonly port?: number;
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => unknown;
    }): () => void;
}
export interface WebBridgeOptions {
    runtime: LocalModelRuntime;
    store: ConfigStore;
    /** 每次配置变化后重建（分组顺序跟着 schema 走）。 */
    form: () => FormDescriptor;
    pluginVersion: string;
    log: Log;
}
/**
 * 把插件的状态与配置暴露给浏览器半侧。
 *
 * 为什么走自建路由而不是 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy
 * 只服务硬编码的命名空间白名单，第三方插件的命名空间一律答复 settings-not-exposed，
 * 浏览器侧既读不到也写不进。同源 HTTP 是这一版宿主上唯一可靠的通道，也让设置页
 * 不依赖宿主内部接口的变动。
 *
 * 安全姿态（本机工具，无账号体系，因此靠三条硬约束而不是鉴权）：
 *   1. 只接受回环来源的请求 —— 配置变更与进程启停不该被局域网里的谁触发；
 *   2. 写操作要求 `content-type: application/json` —— 普通表单跨站提交做不到这一点，
 *      于是即便有一个恶意页面在浏览器里跑，也发不出能改配置的请求；
 *   3. 全部请求体有大小上限。
 */
export declare function registerWebBridge(ctx: Context, options: WebBridgeOptions): () => void;
export declare function buildState(options: WebBridgeOptions): Record<string, unknown>;
