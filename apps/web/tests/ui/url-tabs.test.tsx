/**
 * `URLTabs` — the active tab lives in `?tab=`, so a deep link opens its section; the vertical rail
 * (Settings) heads each run of tabs with its group once and keeps the same tab semantics.
 */
import { fireEvent, screen } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { URLTabs } from '@/ui/components/shared'
import { renderWithProviders } from './helpers/renderWithProviders'

function Where() {
  return <output data-testid="search">{useLocation().search}</output>
}

const TABS = [
  { id: 'general', label: 'General', group: 'Organisation', content: <p>General body</p> },
  { id: 'people', label: 'People', group: 'Organisation', content: <p>People body</p> },
  { id: 'ai', label: 'AI', group: 'AI', content: <p>AI body</p> },
  { id: 'usage', label: 'Usage', group: 'AI', content: <p>Usage body</p> },
]

describe('URLTabs, vertical', () => {
  it('opens the deep-linked section and moves ?tab= when another is chosen', () => {
    renderWithProviders(
      <>
        <URLTabs orientation="vertical" defaultTab="general" tabs={TABS} />
        <Where />
      </>,
      { route: '/settings?tab=ai' }
    )
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('AI body')

    fireEvent.click(screen.getByRole('tab', { name: 'People' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=people')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('People body')
  })

  it('heads each run of tabs with its group exactly once', () => {
    renderWithProviders(<URLTabs orientation="vertical" tabs={TABS} />, { route: '/settings' })
    expect(screen.getAllByText('Organisation')).toHaveLength(1)
    // "AI" is both a group heading and a tab label: one heading + one tab.
    expect(screen.getAllByText('AI')).toHaveLength(2)
    expect(screen.getByRole('tabpanel')).toHaveTextContent('General body')
  })
})
