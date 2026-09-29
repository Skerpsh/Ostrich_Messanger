import { useEffect, useState } from "react";

// Re-renders the component every minute, for relative times such as
// "last seen 5 min ago".
export function useMinuteTick() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}
