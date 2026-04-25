import { type NextRequest, NextResponse } from "next/server"
import { getUser } from "@/lib/auth/get-user"
import { createClient } from "@/lib/supabase/server"
import { cookies } from "next/headers"
import { verifyCsrfToken } from "@/lib/csrf"
import { isValidUsername } from "@/lib/utils/username"
import { rateLimitMiddleware } from "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  try {
    // CSRF protection
    const csrfResult = await verifyCsrfToken(request)
    if (!csrfResult.valid) {
      return NextResponse.json({ error: csrfResult.error || "Invalid CSRF token" }, { status: 403 })
    }

    // Get authenticated user
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Rate limiting - restored with reasonable limits (10 requests per minute)
    const rateLimitResult = rateLimitMiddleware(request, "USERNAME_UPDATE", user.id)
    if (rateLimitResult?.error) {
      return rateLimitResult.error
    }

    const body = await request.json()
    const { username } = body

    if (!username || typeof username !== "string") {
      return NextResponse.json({ error: "Username is required" }, { status: 400 })
    }

    // Validate username format
    if (!isValidUsername(username)) {
      return NextResponse.json(
        { error: "Username must be 3-30 characters long and contain only letters, numbers, and hyphens" },
        { status: 400 },
      )
    }

    // Create Supabase client with cookies
    const cookieStore = cookies()
    const supabase = createClient(cookieStore)

    // Check if username is already taken by another user
    const { data: existingUser, error: checkError } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .neq("id", user.id)
      .single()

    if (checkError && checkError.code !== "PGRST116") {
      console.error("Error checking username:", checkError)
      return NextResponse.json({ error: "Failed to check username availability" }, { status: 500 })
    }

    if (existingUser) {
      return NextResponse.json({ error: "Username is already taken" }, { status: 400 })
    }

    // Update username
    const { error: updateError } = await supabase.from("users").update({ username }).eq("id", user.id)

    if (updateError) {
      console.error("Error updating username:", updateError)
      return NextResponse.json({ error: "Failed to update username" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error in update-username:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
