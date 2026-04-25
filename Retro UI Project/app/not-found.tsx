import { Button } from "@/components/ui/button"
import { AlertCircle, Home, ArrowLeft } from "lucide-react"
import Link from "next/link"

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md mx-auto">
        {/* Updated card with consistent styling */}
        <div className="bg-card border-2 rounded-lg p-8 text-center">
          {/* Modern icon styling */}
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
          </div>

          {/* Clean typography */}
          <h1 className="text-2xl font-semibold mb-3">Page Not Found</h1>
          <p className="text-muted-foreground mb-6">
            The booking page you're looking for doesn't exist or may have been moved.
          </p>

          {/* Simplified explanation */}
          <div className="bg-muted/50 border rounded-lg p-4 mb-6">
            <p className="text-sm text-muted-foreground mb-2">This could happen if:</p>
            <ul className="text-sm text-muted-foreground text-left space-y-1">
              <li>• The event type was deleted or deactivated</li>
              <li>• The username or URL was changed</li>
              <li>• There's a typo in the URL</li>
            </ul>
          </div>

          {/* Clean button layout */}
          <div className="flex flex-col gap-3">
            <Button variant="outline" asChild className="w-full bg-transparent">
              <Link href="javascript:history.back()">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Go Back
              </Link>
            </Button>
            <Button asChild className="w-full">
              <Link href="/">
                <Home className="mr-2 h-4 w-4" />
                Home
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
