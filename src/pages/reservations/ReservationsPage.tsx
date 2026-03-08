import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate } from "react-router-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardProperties } from "@/hooks/useDashboardProperties";
import { useDashboardReservations } from "@/hooks/useDashboardReservations";

function fmt(d: string) {
  return new Date(d).toLocaleString();
}

function operationalStatusLabel(
  status: "UPCOMING" | "IN_HOUSE" | "CHECKED_OUT" | "CANCELLED"
) {
  if (status === "IN_HOUSE") return "IN HOUSE";
  if (status === "CHECKED_OUT") return "CHECKED OUT";
  return status;
}

function OperationalStatusBadge({
  status,
}: {
  status: "UPCOMING" | "IN_HOUSE" | "CHECKED_OUT" | "CANCELLED";
}) {
  if (status === "UPCOMING") {
    return (
      <Badge
        variant="outline"
        className="border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50"
      >
        {operationalStatusLabel(status)}
      </Badge>
    );
  }

  if (status === "IN_HOUSE") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50"
      >
        {operationalStatusLabel(status)}
      </Badge>
    );
  }

  if (status === "CHECKED_OUT") {
    return (
      <Badge
        variant="outline"
        className="border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-50"
      >
        {operationalStatusLabel(status)}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-red-200 bg-red-50 text-red-700 hover:bg-red-50"
    >
      {operationalStatusLabel(status)}
    </Badge>
  );
}

export function ReservationsPage() {
  const [propertyId, setPropertyId] = useState<string>("ALL");
  const [status, setStatus] = useState<"ALL" | "ACTIVE" | "CANCELLED">("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const pageSize = 25;

  const propsQ = useDashboardProperties();
  const resQ = useDashboardReservations({
    page,
    pageSize,
    propertyId: propertyId === "ALL" ? undefined : propertyId,
    status: status === "ALL" ? undefined : status,
    search: search.trim() ? search.trim() : undefined,
    sort: "checkIn_desc",
  });

  const items = resQ.data?.items ?? [];
  const total = resQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const canPrev = page > 1;
  const canNext = page < pages;

  const loading = resQ.isLoading || resQ.isFetching;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reservations</h1>
        <p className="text-sm text-muted-foreground">
          Search and filter PMS reservations. Server-side pagination & sorting.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search guest, email, room, externalId…"
            className="lg:max-w-sm"
          />

          <div className="flex flex-wrap gap-3">
            <Select
              value={propertyId}
              onValueChange={(v) => {
                setPropertyId(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Property" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All properties</SelectItem>
                {(propsQ.data?.items ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as "ALL" | "ACTIVE" | "CANCELLED");
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All status</SelectItem>
                <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                <SelectItem value="CANCELLED">CANCELLED</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="text-sm text-muted-foreground lg:ml-auto">
            {loading ? "Loading…" : `${total} total`}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Results</CardTitle>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canPrev || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <div className="text-sm text-muted-foreground">
              Page <span className="font-medium text-foreground">{page}</span> / {pages}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canNext || loading}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              Next
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Check-in</TableHead>
                  <TableHead>Check-out</TableHead>
                  <TableHead>Operational</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-muted-foreground">
                      No reservations found.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/reservations/${r.id}`)}
                    >
                      <TableCell>
                        <div className="font-medium">{r.guestName}</div>
                        <div className="text-xs text-muted-foreground">{r.guestEmail ?? ""}</div>
                        {r.roomName ? (
                          <div className="text-xs text-muted-foreground">{r.roomName}</div>
                        ) : null}
                      </TableCell>

                      <TableCell className="font-medium">
                        {r.property?.name ?? "—"}
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground">
                        {fmt(r.checkIn)}
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground">
                        {fmt(r.checkOut)}
                      </TableCell>

                      <TableCell>
                        <OperationalStatusBadge status={r.operationalStatus} />
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground">
                        {r.externalProvider ?? r.source ?? "—"}
                        {r.externalId ? (
                          <span className="text-xs text-muted-foreground"> {" "}({r.externalId})</span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}