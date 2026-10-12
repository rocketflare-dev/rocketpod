import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ThemeToggle from '@/ui/components/ThemeToggle'

describe('ThemeToggle', () => {
  it('defaults to rocketpod-light and toggles to rocketpod-dark, persisting to localStorage', () => {
    render(<ThemeToggle />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketpod-light')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketpod-dark')
    expect(localStorage.getItem('theme')).toBe('rocketpod-dark')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketpod-light')
    expect(localStorage.getItem('theme')).toBe('rocketpod-light')
  })

  it('restores a saved theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'rocketpod-dark')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketpod-dark')
  })

  it('ignores an unknown stored theme instead of desyncing from the DOM', () => {
    localStorage.setItem('theme', 'some-old-theme')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketpod-light')
    expect(localStorage.getItem('theme')).toBe('rocketpod-light')
  })
})
