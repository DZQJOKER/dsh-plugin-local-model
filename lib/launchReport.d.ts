/**
 * 启动参数报告：把「这一次到底下发了什么」整理成给人看的东西。
 *
 * 要解决的是一个很具体的观察困难：插件的参数来自三个地方（设置页、构建的默认值、
 * 探测后的门控跳过），最终只有一行拼好的命令行躺在日志里 —— 几百个字符连成一片，
 * 没人会去逐字比对「我以为设了什么」和「实际发了什么」。
 *
 * 所以这里做两件事：
 *   1. 把命令行拆成**一行一项**，每一项都从真实 args 里读出来（不是从配置读的 ——
 *      那样只能证明「配置是什么」，证明不了「实际发了什么」）；
 *   2. 把没识别到的选项也列出来。**看不见的选项比错误的值更危险**：
 *      识别表会随构建变化而过时，漏掉的项如果不报出来，用户就永远不知道它被发了。
 *
 * 纯函数：不碰进程、不碰 fs，输入确定则输出确定，因此能被单测逐个钉死。
 */
export interface LaunchFact {
    /** 分组标题，客户端据此分栏；同一份报告里按出现顺序去重即得分栏顺序。 */
    group: string;
    label: string;
    value: string;
    /** 需要多解释一句时用（例如「越大召回越好但越吃显存」）。 */
    note?: string;
}
export interface LaunchReport {
    executable: string;
    /** 逐项一行，给界面直接渲染成代码块。 */
    lines: string[];
    /** 单行版本，方便复制粘贴到终端。 */
    commandLine: string;
    /** 参数摘要（已从真实 args 解析）。 */
    facts: LaunchFact[];
    /** 拼参数层给出的提示（被跳过的选项、自动收敛、互斥说明……）。 */
    notices: string[];
    /** 识别表没覆盖到的选项 —— 宁可多列出来，也不要让任何一项隐形。 */
    unrecognized: string[];
}
export interface LaunchReportInput {
    executable: string;
    args: string[];
    notices?: string[];
}
/** 逐项一行（供界面渲染），顺序与命令行一致。 */
export declare function renderLaunchLines(executable: string, args: string[]): string[];
/** 单行版本，可直接复制到终端。含空格的值加引号。 */
export declare function renderCommandLine(executable: string, args: string[]): string;
/**
 * 生成报告。
 *
 * 解析对象是**拼好的 args 数组**而不是 config —— 这是这份报告唯一有意义的口径：
 * 设置页里的值和真正发出去的参数之间隔着一层门控与默认值，
 * 只有从 args 读出来的东西才能回答「现在到底跑在什么参数上」。
 */
export declare function buildLaunchReport(input: LaunchReportInput): LaunchReport;
