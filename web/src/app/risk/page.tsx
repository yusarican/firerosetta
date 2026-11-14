import type { Metadata } from "next";
import { RiskDashboard } from "@/components/fire/risk-dashboard";

export const metadata: Metadata = {
  title: "Risk Alerts · FireRosetta",
  description: "Prioritise preventive checks using recent satellite detections and seasonal fire history.",
};

export default function RiskPage() {
  return <RiskDashboard />;
}
