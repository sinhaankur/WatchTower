import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { cookies } from "next/headers"

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const error = searchParams.get("error")
  const next = searchParams.get("next") ?? "/"
  const state = searchParams.get("state")

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error:", error)
    return NextResponse.redirect(`${origin}/?auth_error=${error}`)
  }

  if (!code) {
    console.error("No authorization code provided")
    return NextResponse.redirect(`${origin}/?auth_error=no_code`)
  }

  try {
    const cookieStore = cookies()
    const supabase = createClient(cookieStore)

    // Security: Validate state parameter for Google Calendar connections
    if (state?.startsWith("google_calendar_connect")) {
      return handleGoogleCalendarCallback(code, origin, supabase, state)
    }

    // Handle regular Supabase authentication
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    const user = data?.user

    if (exchangeError) {
      console.error("Session exchange error:", exchangeError)
      return NextResponse.redirect(`${origin}/?auth_error=exchange_failed`)
    }

    if (user) {
      // Ensure user profile exists with proper username
      const { generateUniqueUsername } = await import("@/lib/utils/username")

      // First check if profile already exists
      const { data: existingProfile } = await supabase.from("users").select("username").eq("id", user.id).single()

      let username = existingProfile?.username

      // If no username, generate a new one
      if (!username) {
        username = generateUniqueUsername(user.user_metadata.name, user.email || "")

        // Verify that the username is not taken
        const { data: existingUser } = await supabase
          .from("users")
          .select("id")
          .eq("username", username)
          .neq("id", user.id)
          .single()

        // If taken, add a number
        if (existingUser) {
          let counter = 1
          let newUsername = `${username}${counter}`

          while (true) {
            const { data: checkUser } = await supabase.from("users").select("id").eq("username", newUsername).single()

            if (!checkUser) {
              username = newUsername
              break
            }

            counter++
            newUsername = `${username}${counter}`
          }
        }
      }

      // Upsert user profile
      await supabase.from("users").upsert(
        {
          id: user.id,
          username: username,
          full_name: user.user_metadata.name,
          avatar_url: user.user_metadata.avatar_url,
          email: user.email,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )

      return NextResponse.redirect(`${origin}${next}`)
    }

    return NextResponse.redirect(`${origin}/?auth_error=no_user`)
  } catch (error) {
    console.error("Error in auth callback:", error)
    return NextResponse.redirect(`${origin}/?auth_error=callback_failed`)
  }
}

async function handleGoogleCalendarCallback(code: string, origin: string, supabase: any, state: string) {
  try {
    // Security: Validate state parameter format
    if (!state.match(/^google_calendar_connect_\d+_[a-z0-9]+$/)) {
      console.error("Invalid state parameter format")
      return NextResponse.redirect(`${origin}/?google_error=invalid_state`)
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      console.error("No authenticated user for Google Calendar callback")
      return NextResponse.redirect(`${origin}/?google_error=auth_error`)
    }

    // Security: Validate environment variables
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      console.error("Google OAuth credentials not configured")
      return NextResponse.redirect(`${origin}/?google_error=config_error`)
    }

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: `${origin}/auth/callback`,
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json()
      console.error("Token exchange failed:", errorData)
      return NextResponse.redirect(`${origin}/?google_error=token_error`)
    }

    const tokens = await tokenResponse.json()

    // Security: Validate token response
    if (!tokens.access_token) {
      console.error("No access token received from Google")
      return NextResponse.redirect(`${origin}/?google_error=no_token`)
    }

    // Security: Verify token scopes (optional but recommended)
    try {
      const tokenInfoResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`,
      )
      if (tokenInfoResponse.ok) {
        const tokenInfo = await tokenInfoResponse.json()
        const requiredScopes = ["https://www.googleapis.com/auth/calendar.events"]
        const hasRequiredScopes = requiredScopes.every((scope) => tokenInfo.scope?.includes(scope))

        if (!hasRequiredScopes) {
          console.error("Token does not have required scopes")
          return NextResponse.redirect(`${origin}/?google_error=insufficient_scope`)
        }
      }
    } catch (scopeError) {
      console.error("Failed to verify token scopes:", scopeError)
      // Continue anyway as this is not critical
    }

    // Save tokens to database
    const { error: updateError } = await supabase
      .from("users")
      .update({
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)

    if (updateError) {
      console.error("Failed to save Google tokens:", updateError)
      return NextResponse.redirect(`${origin}/?google_error=database_error`)
    }

    return NextResponse.redirect(`${origin}/?google_connected=true`)
  } catch (error) {
    console.error("Error in Google Calendar callback:", error)
    return NextResponse.redirect(`${origin}/?google_error=callback_failed`)
  }
}
