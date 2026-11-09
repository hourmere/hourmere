import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { App } from './App.tsx'
import { installPreloadRecovery } from './preload-recovery.ts'
import './styles.css'

installPreloadRecovery()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

const router = createBrowserRouter([{ path: '*', element: <App /> }])

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
