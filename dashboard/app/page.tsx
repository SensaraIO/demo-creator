import Dashboard from "@/components/Dashboard";
import { getSnapshot } from "@/lib/projects";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <Dashboard initial={snapshot} />;
}
