import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'
import './facebook.css'
import './chat.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
