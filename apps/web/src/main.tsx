import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { createAppRouter, isRoutingContinuationPath } from './App.tsx'
import { installPreloadRecovery } from './preload-recovery.ts'
import './styles.css'

const router = createAppRouter()
// A reload would discard a cleared, in-memory continuation capability.
installPreloadRecovery(() => !isRoutingContinuationPath(window.location.pathname))

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
