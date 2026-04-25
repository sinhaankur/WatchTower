"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Copy, Check, Loader2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

export function CopyLinkButton({ link, ...props }: { link: string } & React.ComponentProps<typeof Button>) {
  const [isCopied, setIsCopied] = useState(false)
  // Added loading state to prevent rage clicking
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleCopy = async () => {
    // Prevent multiple clicks while processing
    if (isLoading || isCopied) return

    setIsLoading(true)
    try {
      await navigator.clipboard.writeText(link)
      setIsCopied(true)
      toast({
        title: "Copied to clipboard!",
        description: "You can now share the link.",
      })
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy: ", err)
      toast({
        title: "Failed to copy",
        description: "Could not copy link to clipboard.",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Button onClick={handleCopy} disabled={isLoading || isCopied} {...props}>
      {/* Enhanced loading states with proper icons */}
      {isLoading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Copying...
        </>
      ) : isCopied ? (
        <>
          <Check className="mr-2 h-4 w-4" />
          Copied
        </>
      ) : (
        <>
          <Copy className="mr-2 h-4 w-4" />
          Copy Link
        </>
      )}
    </Button>
  )
}
