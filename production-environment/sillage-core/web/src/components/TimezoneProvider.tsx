import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { resolveTimeZone } from "@/lib/timezone";

const TimezoneContext = createContext("UTC");

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const tz = resolveTimeZone(data?.schedule_timezone);
  return <TimezoneContext.Provider value={tz}>{children}</TimezoneContext.Provider>;
}

export function useOperatorTimezone(): string {
  return useContext(TimezoneContext);
}
