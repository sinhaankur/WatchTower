import { notFound } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { getEventTypeBySlugForUser } from "@/lib/actions/event-types"
import { EditEventTypeForm } from "@/components/edit-event-type-form"
import { getUser } from "@/lib/auth/get-user"

export default async function EditEventTypePage({ params }: { params: { slug: string } }) {
  const [eventType, user] = await Promise.all([getEventTypeBySlugForUser(params.slug), getUser()])

  if (!eventType || !user) {
    notFound()
  }

  const eventTypeWithUser = { ...eventType, user_name: user.user_name || "your-name" }

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-2xl space-y-6">
        {/* Also updated the back button in edit page for consistency */}
        <Button variant="outline" asChild className="bg-transparent hover:scale-105">
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Event Types
          </Link>
        </Button>

        <Card className="bg-white">
          <CardHeader>
            <CardTitle>Edit Event Type</CardTitle>
            <CardDescription>Update the details for this event type.</CardDescription>
          </CardHeader>
          <CardContent>
            <EditEventTypeForm eventType={eventTypeWithUser} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
