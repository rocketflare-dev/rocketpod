/**
 * `Modal` is named by its title, so a screen reader announces the dialog and a test (or a person
 * using a screen reader's dialog list) can find it by name rather than by `dialog[open]`.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Modal } from '@/ui/components/shared/Modal'

describe('Modal', () => {
  it('takes its accessible name from the title', () => {
    render(
      <Modal open onClose={() => {}} title="Invite people">
        <p>body</p>
      </Modal>
    )
    expect(screen.getByRole('dialog', { name: 'Invite people', hidden: true })).toBeInTheDocument()
  })
})
