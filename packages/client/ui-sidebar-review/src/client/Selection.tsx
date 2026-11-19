/** Pointer selection over the document's current viewport bounds. */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CaptureRegion } from '../types.ts'
import css from './Review.module.css'

interface Point {
  readonly x: number
  readonly y: number
}

interface SelectionProps {
  readonly bounds: CaptureRegion
  readonly label: string
  readonly onCancel: () => void
  readonly onSelect: (region: CaptureRegion) => void
}

function rectangle(start: Point, end: Point): CaptureRegion {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  }
}

function position({ x, y, width, height }: CaptureRegion): CSSProperties {
  return { left: x, top: y, width, height }
}

/**
 * Hold a modal selection over the document, closing it before the caller captures pixels.
 * @param props - viewport bounds and selection callbacks.
 * @returns the top-layer selection UI.
 */
export function Selection({ bounds, label, onCancel, onSelect }: SelectionProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const start = useRef<{ readonly pointerId: number; readonly point: Point }>()
  const [area, setArea] = useState<CaptureRegion>()

  useLayoutEffect(() => {
    const element = dialog.current
    /* v8 ignore next -- the dialog ref is attached before its layout effect. */
    if (element === null) return
    element.showModal()
    window.addEventListener('resize', onCancel)
    window.addEventListener('blur', onCancel)
    return () => {
      window.removeEventListener('resize', onCancel)
      window.removeEventListener('blur', onCancel)
      element.close()
    }
  }, [onCancel])
  useModalLayer(dialog, true, onCancel)

  const point = (event: Point): Point => ({
    x: Math.min(Math.max(event.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(event.y, bounds.y), bounds.y + bounds.height),
  })
  return createPortal(
    <dialog ref={dialog} className={css.selection} role="dialog" aria-modal="true" aria-label={label} data-review-selection
      onCancel={(event) => { event.preventDefault(); onCancel() }}>
      <div
        className={css.captureArea} style={position(bounds)}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          start.current = { pointerId: event.pointerId, point: point({ x: event.clientX, y: event.clientY }) }
        }}
        onPointerMove={(event) => {
          const drag = start.current
          if (drag?.pointerId === event.pointerId) setArea(rectangle(drag.point, point({ x: event.clientX, y: event.clientY })))
        }}
        onPointerUp={(event) => {
          const drag = start.current
          if (drag?.pointerId !== event.pointerId) return
          const region = rectangle(drag.point, point({ x: event.clientX, y: event.clientY }))
          if (region.width < 4 || region.height < 4) {
            start.current = undefined
            setArea(undefined)
            return
          }
          dialog.current?.close()
          onSelect(region)
        }}
        onPointerCancel={(event) => {
          if (start.current?.pointerId === event.pointerId) onCancel()
        }}
      >
        {area === undefined && <span className={css.hint}>{label}</span>}
      </div>
      {area !== undefined && <div className={css.selected} style={position(area)} aria-hidden="true" />}
    </dialog>,
    document.body,
  )
}
