import { NextResponse } from "next/server"
import { getCSRFToken } from "@/lib/csrf"

export async function GET() {
  try {
    const token = getCSRFToken()

    return NextResponse.json({
      token,
      success: true,
    })
  } catch (error) {
    console.error("❌ [CSRF_TOKEN_API] Error generating token:", error)

    return NextResponse.json(
      {
        error: "Failed to generate CSRF token",
        success: false,
      },
      { status: 500 },
    )
  }
}
