import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo Dashboard",
  description: "Client demo walkthroughs — generating and finished.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
