import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import CheckerPage from "@/pages/CheckerPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CheckerPage />
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  );
}
