/**
 * Toasts: a zustand queue exposed as `showToast()` so non-React code (api-client) can fire
 * one, and a `ToastContainer` mounted once in App.tsx.
 *
 * Toasts are for problems only — an error or a warning. A success is never toasted: the screen
 * already shows the result. The one exception is `showUndoToast`, because the toast IS the undo.
 */

import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useEffect } from 'react'
import { create } from 'zustand'

export type ToastType = 'error' | 'warning'
/** What the container renders: a problem, or the neutral undo line. */
type ToastKind = ToastType | 'undo'

/** One button beside the message (an Undo); pressing it runs `onClick` and dismisses the toast. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: ToastKind
  duration?: number
  action?: ToastAction
}

interface ToastStore {
  toasts: Toast[]
  addToast: (message: string, type: ToastKind, duration?: number, action?: ToastAction) => void
  removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>(set => ({
  toasts: [],
  addToast: (message, type, duration = 5000, action) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    set(state => ({ toasts: [...state.toasts, { id, message, type, duration, action }] }))
  },
  removeToast: id => {
    set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }))
  },
}))

/** Show an error or a warning from anywhere, inside or outside React. */
export function showToast(message: string, type: ToastType, duration?: number): void {
  useToastStore.getState().addToast(message, type, duration)
}

/** A change that can be taken back: the message and its Undo button. */
export function showUndoToast(message: string, action: ToastAction, duration?: number): void {
  useToastStore.getState().addToast(message, 'undo', duration, action)
}

const iconMap: Record<ToastKind, typeof CheckCircleIcon> = {
  undo: CheckCircleIcon,
  error: ExclamationCircleIcon,
  warning: ExclamationTriangleIcon,
}

// Built from a prop → safelisted via `@source inline` in index.css
const alertClassMap: Record<ToastKind, string> = {
  undo: 'alert-info',
  error: 'alert-error',
  warning: 'alert-warning',
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = iconMap[toast.type]

  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(onDismiss, toast.duration)
      return () => clearTimeout(timer)
    }
  }, [toast.duration, onDismiss])

  return (
    <div className={`alert ${alertClassMap[toast.type]} toast-in`} role="alert">
      <Icon className="h-5 w-5 shrink-0" />
      <span className="text-sm">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={() => {
            toast.action?.onClick()
            onDismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Bottom-right stack. Mount once. */
export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()
  if (toasts.length === 0) return null

  return (
    <div className="toast toast-end toast-bottom z-50">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}
