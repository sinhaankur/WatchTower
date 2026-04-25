import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { getUser } from "@/lib/auth/get-user"
import { getBaseUrl } from "@/lib/utils/url"
import { NewEventTypeForm } from "@/components/new-event-type-form"
import { redirect } from "next/navigation"

export default async function NewEventTypePage() {
  // Added try-catch to handle potential errors in preview environment
  let user
  try {
    user = await getUser()
  } catch (error) {
    console.error("Error getting user in NewEventTypePage:", error)
    redirect("/")
  }

  if (!user) {
    console.log("No user found, redirecting to home")
    redirect("/")
  }

  // Added error handling for baseUrl
  let baseUrl
  try {
    baseUrl = getBaseUrl()
  } catch (error) {
    console.error("Error getting base URL:", error)
    baseUrl = "http://localhost:3000" // fallback
  }

  return (
    // Simplified page layout - cleaner and more spacious
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Simplified header section */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          {/* Simplified title */}
          <h1 className="text-2xl sm:text-3xl font-bold">New Event Type</h1>
          {/* Removed description as requested */}
        </div>

        {/* Updated back button to look like a proper button - removed bg-transparent */}
        <Button variant="outline" asChild>
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
      </div>

      {/* Form container - removed card wrapper for cleaner look */}
      <div className="bg-card border-2 p-6 sm:p-8 shadow-sm">
        <NewEventTypeForm userName={user.user_name} baseUrl={baseUrl} />
      </div>
    </div>
  )
}
