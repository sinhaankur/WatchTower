"use client"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Calendar, Loader2 } from "lucide-react"
import { useState } from "react"

export function LoginForm() {
  const supabase = createClient()
  // Added loading state for Google sign-in
  const [isSigningIn, setIsSigningIn] = useState(false)

  const handleSignIn = async () => {
    // Set loading state when starting sign-in process
    setIsSigningIn(true)

    try {
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${location.origin}/auth/callback`,
          // Redirect back to the root page after login
          queryParams: {
            next: "/",
          },
        },
      })
    } catch (error) {
      console.error("Error signing in:", error)
      // Reset loading state on error
      setIsSigningIn(false)
    }
  }

  return (
    // Fixed: Prevent background scroll and ensure perfect centering
    <div className="fixed inset-0 flex items-center justify-center p-4 bg-background overflow-hidden">
      {/* Enhanced card sizing and centering */}
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-4 p-6 sm:p-8">
          <div className="flex justify-center">
            {/* Updated icon background to use primary color from palette */}
            <div className="h-16 w-16 bg-primary/10 flex items-center justify-center border-2">
              <Calendar className="h-8 w-8 text-primary" />
            </div>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-bold">Welcome to v0 Calendar</CardTitle>
            <CardDescription className="text-base">Sign in to manage your events</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
          {/* Updated button to show loading state */}
          <Button onClick={handleSignIn} className="w-full h-12 text-base" size="lg" disabled={isSigningIn}>
            {isSigningIn ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Connecting to Google...
              </>
            ) : (
              <>
                <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                </svg>
                Continue with Google
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
