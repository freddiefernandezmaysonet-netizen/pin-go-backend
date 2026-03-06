import { useDashboardOverview } from "@/api/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

function StatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value?: number;
  loading: boolean;
}) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-20 rounded-lg" />
        ) : (
          <div className="text-3xl font-semibold tracking-tight">{value ?? 0}</div>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, error } = useDashboardOverview();

  const loading = isLoading || isFetching;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Live operational status from Pin&Go (workers + integrations).
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => qc.invalidateQueries({ queryKey: ["dashboard"] })}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="rounded-2xl">
          <CardContent className="p-4 text-sm">
            Error: {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Reservations" value={data?.activeReservations} loading={loading} />
        <StatCard label="Check-ins Today" value={data?.checkInsToday} loading={loading} />
        <StatCard label="Check-outs Today" value={data?.checkOutsToday} loading={loading} />
        <StatCard label="Active Locks" value={data?.activeLocks} loading={loading} />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">System</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {loading ? (
            <Skeleton className="h-4 w-52" />
          ) : (
            <>Last updated: {new Date(data?.updatedAt ?? "").toLocaleString()}</>
          )}
        </CardContent>
      </Card>
    </div>
  );
}