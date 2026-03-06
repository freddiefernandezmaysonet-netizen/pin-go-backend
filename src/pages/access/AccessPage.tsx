import { useState } from "react";
import { useDashboardAccess, useDashboardProperties } from "@/api/hooks";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

function fmt(d: string) {
  return new Date(d).toLocaleString();
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-sm text-muted-foreground">{hint}</div>
    </div>
  );
}

export function AccessPage() {
  const [propertyId, setPropertyId] = useState<string>("ALL");

  const propsQ = useDashboardProperties();
  const accessQ = useDashboardAccess({
    propertyId: propertyId === "ALL" ? undefined : propertyId,
  });

  const loading = accessQ.isLoading || accessQ.isFetching;

  const guest = accessQ.data?.guestPasscodes ?? [];
  const staff = accessQ.data?.staffPasscodes ?? [];
  const nfc = accessQ.data?.nfc ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Access</h1>
          <p className="text-sm text-muted-foreground">
            Live access windows (Passcodes + NFC). Read-only control center.
          </p>
        </div>

        <Select value={propertyId} onValueChange={(v) => setPropertyId(v)}>
          <SelectTrigger className="w-[240px]">
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
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Live</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {loading ? (
            <Skeleton className="h-4 w-56" />
          ) : (
            <>Now: {fmt(accessQ.data?.now ?? new Date().toISOString())}</>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="nfc" className="space-y-4">
        <TabsList>
          <TabsTrigger value="nfc">NFC ({nfc.length})</TabsTrigger>
          <TabsTrigger value="guest">Guest Passcodes ({guest.length})</TabsTrigger>
          <TabsTrigger value="staff">Staff Passcodes ({staff.length})</TabsTrigger>
        </TabsList>

        {/* NFC */}
        <TabsContent value="nfc">
          <Card className="rounded-2xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Active NFC Assignments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guest</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Card</TableHead>
                      <TableHead>Window</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={6}>
                            <Skeleton className="h-6 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : nfc.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <EmptyState
                            title="No active NFC assignments"
                            hint="NFC assignments will appear here when reservations are within their active window."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      nfc.map((a) => (
                        <TableRow key={a.assignmentId} className="hover:bg-muted/50">
                          <TableCell>
                            <div className="font-medium">{a.guestName}</div>
                            <div className="text-xs text-muted-foreground">{a.roomName ?? ""}</div>
                          </TableCell>
                          <TableCell className="font-medium">{a.property.name}</TableCell>
                          <TableCell>
                            <Badge variant={a.role === "CLEANING" ? "secondary" : "default"}>
                              {a.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {a.card.label ?? "Card"}{" "}
                            <span className="text-xs">#{a.card.ttlockCardId}</span>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {fmt(a.startsAt)} → {fmt(a.endsAt)}
                          </TableCell>
                          <TableCell>
                            <Badge>{a.status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Guest Passcodes */}
        <TabsContent value="guest">
          <Card className="rounded-2xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Guest Passcodes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guest</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead>Lock</TableHead>
                      <TableHead>Window</TableHead>
                      <TableHead>Code</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={5}>
                            <Skeleton className="h-6 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : guest.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <EmptyState
                            title="No active guest passcodes"
                            hint="Passcodes will appear here when ACTIVE and within their access window."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      guest.map((g) => (
                        <TableRow key={g.grantId} className="hover:bg-muted/50">
                          <TableCell>
                            <div className="font-medium">{g.guestName}</div>
                            <div className="text-xs text-muted-foreground">{g.roomName ?? ""}</div>
                          </TableCell>
                          <TableCell className="font-medium">{g.property?.name ?? "—"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {g.lock?.name ?? "—"}{" "}
                            {g.lock?.ttlockLockId ? <span className="text-xs">#{g.lock.ttlockLockId}</span> : null}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {fmt(g.startsAt)} → {fmt(g.endsAt)}
                          </TableCell>
                          <TableCell>
                            {g.codeMasked ? <Badge variant="outline">{g.codeMasked}</Badge> : "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Staff Passcodes */}
        <TabsContent value="staff">
          <Card className="rounded-2xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Staff Passcodes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead>Lock</TableHead>
                      <TableHead>Window</TableHead>
                      <TableHead>Code</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={5}>
                            <Skeleton className="h-6 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : staff.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <EmptyState
                            title="No active staff passcodes"
                            hint="Staff passcodes appear here when ACTIVE and within their window."
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      staff.map((s) => (
                        <TableRow key={s.grantId} className="hover:bg-muted/50">
                          <TableCell className="font-medium">
                            {s.staffMember?.fullName ?? "Staff"}
                          </TableCell>
                          <TableCell className="font-medium">{s.lock.property.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {s.lock.name ?? "—"}{" "}
                            <span className="text-xs">#{s.lock.ttlockLockId}</span>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {fmt(s.startsAt)} → {fmt(s.endsAt)}
                          </TableCell>
                          <TableCell>
                            {s.codeMasked ? <Badge variant="outline">{s.codeMasked}</Badge> : "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}