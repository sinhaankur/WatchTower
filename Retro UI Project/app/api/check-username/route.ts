import { createClient } from "@/lib/supabase/server"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { usernameSchema } from "@/lib/validations/schemas"
import { rateLimitMiddleware } from "@/lib/rate-limit"
import { csrfMiddleware } from "@/lib/csrf"

export async function POST(request: Request) {
  // CSRF protection check
  const csrfCheck = csrfMiddleware(request)
  if (csrfCheck) {
    return csrfCheck.error
  }

  // Rate limiting check
  const rateLimitCheck = rateLimitMiddleware(request, "USERNAME_CHECK")
  if (rateLimitCheck) {
    return rateLimitCheck.error
  }

  try {
    const body = await request.json()

    // Validate input data with Zod
    try {
      const { username } = usernameSchema.parse(body)

      const cookieStore = cookies()
      const supabase = createClient(cookieStore)

      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        return NextResponse.json({ available: false, error: "Not authenticated" })
      }

      // Check if username is taken by another user
      const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .neq("id", user.id)
        .single()

      return NextResponse.json({ available: !existingUser })
    } catch (validationError) {
      // Handle validation errors
      if (validationError instanceof Error && "issues" in validationError) {
        const zodError = validationError as any
        const firstError = zodError.issues?.[0]
        const errorMessage = firstError?.message || "Invalid username format"

        return NextResponse.json({ available: false, error: errorMessage })
      }

      return NextResponse.json({ available: false, error: "Invalid input data" })
    }
  } catch (error) {
    console.error("Error checking username:", error)
    return NextResponse.json({ available: false, error: "Server error" })
  }
}
