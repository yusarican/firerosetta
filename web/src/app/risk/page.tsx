import type { Metadata } from "next";
import { RiskDashboard } from "@/components/fire/risk-dashboard";

export const metadata: Metadata = {
  title: "Risk Uyarıları · FireRosetta",
  description: "Yakın dönem uydu tespitleri ve mevsimsel yangın geçmişiyle önlem önceliği taşıyan alanlar.",
};

export default function RiskPage() {
  return <RiskDashboard />;
}
