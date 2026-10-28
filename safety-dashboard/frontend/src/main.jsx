import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './api.js'   // auth header + session handling for all API calls (TG-010)
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
