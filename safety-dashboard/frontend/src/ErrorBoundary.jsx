import { Component } from 'react'

// Keeps a page error from blanking the whole dashboard: shows what failed and a way back.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('[dashboard] page error:', error, info?.componentStack) }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ maxWidth: '720px', margin: '40px auto', padding: '20px 24px', background: '#FFF7ED',
                    border: '1px solid #FDBA74', borderRadius: '10px', color: '#7C2D12', fontSize: '14px' }}>
        <strong>This page hit an error and could not be shown.</strong>
        <div style={{ margin: '8px 0', fontFamily: 'monospace', fontSize: '12px' }}>{String(this.state.error?.message || this.state.error)}</div>
        <div>Your data is not affected. Use the menu to open another page, or reload the browser tab.</div>
        <button onClick={() => this.setState({ error: null })}
                style={{ marginTop: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #EA580C',
                         background: '#FFFFFF', color: '#9A3412', cursor: 'pointer' }}>Try again</button>
      </div>
    )
  }
}
