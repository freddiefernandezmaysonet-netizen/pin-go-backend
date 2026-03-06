import { useState } from "react";
import { useDashboardLocks, useDashboardProperties } from "@/api/hooks";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

function ActiveBadge({ isActive }: { isActive: boolean }) {
  return isActive ? <Badge>ACTIVE</Badge> : <Badge variant="secondary">INACTIVE</Badge>;
}

export function LocksPage() {
  const [propertyId, setPropertyId] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const propsQ = useDashboardProperties();
  const locksQ = useDashboardLocks({
    page,
    pageSize,
    propertyId: propertyId === "ALL" ? undefined : propertyId,
    search: search.trim() ? search.trim() : undefined,
  });

  const loading = locksQ.isLoading || locksQ.isFetching;
  const items = locksQ.data?.items ?? [];
  const total = locksQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < pages;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Locks</h1>
        <p className="text-sm text-muted-foreground">
          TTLock-connected locks. Battery will be added via backend cache.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search lock name or ttlockLockId…"
            className="lg:max-w-sm"
          />

          <Select
            value={propertyId}
            onValueChange={(v) => { setPropertyId(v); setPage(1); }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Property" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All properties</SelectItem>
              {(propsQ.data?.items ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="lg:ml-auto text-sm text-muted-foreground">
            {loading ? "Loading…" : `${total} total`}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Results</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!canPrev || loading} onClick={() => setPage(p => Math.max(1, p-1))}>
              Prev
            </Button>
            <div className="text-sm text-muted-foreground">
              Page <span className="text-foreground font-medium">{page}</span> / {pages}
            </div>
            <Button variant="outline" size="sm" disabled={!canNext || loading} onClick={() => setPage(p => Math.min(pages, p+1))}>
              Next
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lock</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Battery</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-sm text-muted-foreground">
                      No locks found.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((l) => (
                    <TableRow key={l.id} className="hover:bg-muted/50">
                      <TableCell>
                        <div className="font-medium">{l.name ?? "TTLock Lock"}</div>
                        <div className="text-xs text-muted-foreground">ttlockLockId: {l.ttlockLockId}</div>
                      </TableCell>
                      <TableCell className="font-medium">{l.property.name}</TableCell>
                      <TableCell><ActiveBadge isActive={l.isActive} /></TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {l.battery == null ? "—" : `${l.battery}%`}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(l.updatedAt).toLocaleString()}
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