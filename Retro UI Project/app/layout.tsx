import type React from "react"
import { DM_Sans, Space_Mono } from "next/font/google"
import "./globals.css"
// Added AuthButton import back for the topbar
import { AuthButton } from "@/components/auth-button"
// Added Calendar icon import for branding
import { Calendar } from "lucide-react"
// Added Link import for navigation
import Link from "next/link"
import { Analytics } from "@vercel/analytics/react"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Suspense } from "react"
// Added headers import to detect booking pages
import { headers } from "next/headers"
// Added getUser import to detect authentication status
import { getUser } from "@/lib/auth/get-user"

const fontSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "700"],
})

export const metadata = {
  title: "v0 Calendar",
  // Enhanced description for better SEO and social sharing
  description:
    "Smart scheduling and booking platform for professionals. Create custom event types, sync with Google Calendar, and let clients book meetings seamlessly.",
  // Enhanced Open Graph metadata for better social sharing
  openGraph: {
    title: "v0 Calendar - Smart Scheduling Made Simple",
    description:
      "Professional scheduling platform with Google Calendar sync, custom event types, and seamless booking experience.",
    type: "website",
    locale: "en_US",
    url: "https://v0calendar.vercel.app",
    siteName: "v0 Calendar",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "v0 Calendar - Smart Scheduling Platform",
      },
    ],
  },
  // Twitter Card metadata
  twitter: {
    card: "summary_large_image",
    title: "v0 Calendar - Smart Scheduling Made Simple",
    description: "Professional scheduling platform with Google Calendar sync and seamless booking experience.",
    images: ["/og-image.png"],
    creator: "@EstebanSuarez",
  },
  // Additional metadata
  keywords: [
    "scheduling",
    "booking",
    "calendar",
    "appointments",
    "meetings",
    "google calendar",
    "professional",
    "business",
  ],
  authors: [{ name: "Esteban Suarez", url: "https://x.com/EstebanSuarez" }],
  creator: "Esteban Suarez",
  // Added favicon reference to the new calendar icon
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png",
  },
  // Verification and additional meta
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
    generator: 'v0.app'
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Detect if we're on a public booking page to hide the topbar
  const headersList = headers()
  const pathname = headersList.get("x-pathname") || ""

  // Check authentication status to hide topbar on login page
  const user = await getUser()

  // Check if this is a public booking page (pattern: /username/slug OR /username)
  // We exclude known app routes like /events, /booking, /api, etc.
  // Added: Also include booking confirmed pages as public pages
  const isPublicBookingPage =
    ((pathname.match(/^\/[^/]+\/[^/]+$/) || (pathname.match(/^\/[^/]+$/) && pathname !== "/")) &&
      !pathname.startsWith("/events") &&
      !pathname.startsWith("/api") &&
      pathname !== "/") ||
    pathname.startsWith("/booking/") // Added: Include booking confirmed pages

  // Hide topbar if user is not authenticated (login page) OR on public booking pages
  const shouldHideTopbar = !user || isPublicBookingPage

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased", fontSans.variable, fontMono.variable)}>
        <Suspense fallback={<div>Loading...</div>}>
          <div className="min-h-screen bg-background flex flex-col">
            {/* Only show header when user is authenticated AND not on public booking pages */}
            {!shouldHideTopbar && (
              <header className="border-b-2 border-border bg-card">
                <div className="container max-w-screen-2xl px-4 py-3">
                  <div className="flex items-center justify-between">
                    {/* Brand/Logo */}
                    <Link href="/" className="flex items-center space-x-2 hover:scale-105 transition-transform">
                      <div className="w-8 h-8 bg-primary border-2 flex items-center justify-center">
                        <Calendar className="h-5 w-5 text-primary-foreground" />
                      </div>
                      <span className="font-bold text-lg">v0 Calendar</span>
                    </Link>

                    {/* Auth Button - only shows for logged in users */}
                    <AuthButton />
                  </div>
                </div>
              </header>
            )}

            {/* Changed: Different layout for public booking pages vs dashboard pages */}
            {isPublicBookingPage ? (
              // For public booking pages: center everything, no global footer (they have their own)
              <main className="flex-1 flex items-center justify-center p-4">{children}</main>
            ) : (
              // For dashboard pages: keep original layout with separate footer
              <>
                <main className="container max-w-screen-2xl px-4 py-4 flex-1">{children}</main>
                <footer className="border-t border-border bg-card/50 py-6 mt-8">
                  <div className="container max-w-screen-2xl px-4">
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <span>Vibe coded with</span>
                        <Link
                          href="https://v0.dev/community/v0-calendar-CqmWrCLIczY"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary hover:underline"
                        >
                          v0 - Clone and prompt
                        </Link>
                      </div>
                      <span className="hidden sm:inline">•</span>
                      <div className="flex items-center gap-1">
                        <span>feedback?</span>
                        <Link
                          href="https://x.com/EstebanSuarez"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary hover:underline"
                        >
                          send me a dm!
                        </Link>
                      </div>
                    </div>
                  </div>
                </footer>
              </>
            )}
          </div>
        </Suspense>
        <Toaster />
        <Analytics />
      </body>
    </html>
  )
}
