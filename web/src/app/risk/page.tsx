import type { Metadata } from "next";
import { RiskDashboard } from "@/components/fire/risk-dashboard";

export const metadata: Metadata = {
  title: "Early Warning · FireRosetta",
  description: "Observed fire activity and a 1–3 month model outlook, as two layers on one map.",
};

export default function RiskPage() {
  return <RiskDashboard />;
}
