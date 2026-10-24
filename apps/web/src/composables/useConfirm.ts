import { reactive } from 'vue';

/** 确认框参数：替代浏览器原生 window.confirm */
export interface ConfirmOptions {
  /** 标题，默认「确认操作」 */
  title?: string;
  /** 主文案 */
  message: string;
  /** 次要说明，例如「删除后无法恢复」 */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确定按钮用红色，默认聚焦「取消」防止误触 */
  danger?: boolean;
}

/** 全局唯一的确认框状态，由 App 里的 <ConfirmDialog /> 渲染 */
export const confirmState = reactive({
  open: false,
  title: '确认操作',
  message: '',
  detail: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: true,
});

let resolver: ((value: boolean) => void) | null = null;

/** 打开确认框并等待用户选择；同一时间只保留一个待确认请求 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // 前一个请求还挂着时按「取消」处理，避免它的 Promise 永远不结束
  resolver?.(false);
  resolver = null;

  Object.assign(confirmState, {
    open: true,
    title: options.title ?? '确认操作',
    message: options.message,
    detail: options.detail ?? '',
    confirmText: options.confirmText ?? '确定',
    cancelText: options.cancelText ?? '取消',
    danger: options.danger ?? true,
  });

  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

/** 由 ConfirmDialog 调用：关闭并返回用户的选择 */
export function settleConfirm(value: boolean): void {
  confirmState.open = false;
  const resolve = resolver;
  resolver = null;
  resolve?.(value);
}
