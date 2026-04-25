"use client"

// Nuevo hook: detecta si la pantalla es "mobile" basado en un breakpoint.
// DEV: se usa en el componente Calendar para decidir si mostrar el wheel-picker.

import { useEffect, useState } from "react"

/**
 * Retorna `true` si el ancho de la ventana es menor al breakpoint indicado.
 * @param breakpoint Número de píxeles a partir del cual se considera desktop (default 768 px)
 */
export function useMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.innerWidth < breakpoint
  })

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < breakpoint)
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [breakpoint])

  return isMobile
}
