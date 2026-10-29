// Names of the deployed network (channel, chaincode, organisations) for screens and printed
// records — fetched once from /api/network-info instead of being written into the UI.
import { useEffect, useState } from 'react'

let cached = null
let pending = null

export function useNetworkInfo() {
  const [info, setInfo] = useState(cached)
  useEffect(() => {
    if (cached) return
    pending = pending || fetch('/api/network-info')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && j.success) cached = j; return cached })
      .catch(() => null)
      .finally(() => { pending = null })
    pending.then(v => { if (v) setInfo(v) })
  }, [])
  return info
}

export function orgLabel(info, type, fallback) {
  return info?.orgs?.find(o => o.type === type)?.label || fallback
}
