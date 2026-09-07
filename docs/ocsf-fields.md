# SentinelOne OCSF fields

SentinelOne OCSF output uses the native `alert(id, scope).ocsf` GraphQL field. The query selects the fields below and preserves SentinelOne's names and values. SentinelOne may return `null` when an alert has no OCSF representation.

This is a selected projection of SentinelOne's OCSF representation. It is not a complete OCSF event or a conversion to the canonical OCSF JSON schema. The API uses camelCase names and exposes only part of an event. Nested objects can reference themselves, so the query limits process ancestry to one parent.

Paths in this table are relative to `ocsf`. Array paths describe the fields selected on each element.

| Path                                 | Selected fields                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root                                 | `action`, `actionId`, `startTimeDt`, `endTimeDt`                                                                                                  |
| `cloud`                              | `name`, `provider`, `region`, `zone`, `uid`, `uidAlt`, `cloudPartition`, `projectUid`                                                             |
| `cloud.account`                      | `uid`, `name`, `type`, `typeId`                                                                                                                   |
| `cloud.org`                          | `uid`, `name`, `ouUid`, `ouName`                                                                                                                  |
| `findingInfo`                        | `dataSources`, `srcUrl`                                                                                                                           |
| `findingInfo.attacks[]`              | `version`                                                                                                                                         |
| `findingInfo.attacks[].tactic`       | `uid`, `name`, `srcUrl`                                                                                                                           |
| `findingInfo.attacks[].technique`    | `uid`, `name`, `srcUrl`                                                                                                                           |
| `findingInfo.attacks[].subTechnique` | `uid`, `name`, `srcUrl`                                                                                                                           |
| `findingInfo.killChain[]`            | `phase`, `phaseId`                                                                                                                                |
| `observables[]`                      | `name`, `type`, `typeId`, `value`                                                                                                                 |
| `observables[].reputation`           | `baseScore`, `provider`, `score`, `scoreId`                                                                                                       |
| `evidences[]`                        | `uid`, `name`, `verdict`, `verdictId`                                                                                                             |
| `evidences[].device`                 | `uid`, `name`, `hostname`, `ip`, `mac`, `domain`, `type`, `typeId`                                                                                |
| `evidences[].process`                | `uid`, `name`, `pid`, `cmdLine`, `path`, `createdTimeDt`                                                                                          |
| `evidences[].process.file`           | `uid`, `name`, `path`, `size`                                                                                                                     |
| `evidences[].process.file.hashes[]`  | `algorithm`, `algorithmId`, `value`                                                                                                               |
| `evidences[].process.parentProcess`  | `uid`, `name`, `pid`, `cmdLine`, `path`                                                                                                           |
| `evidences[].file`                   | `uid`, `name`, `path`, `size`                                                                                                                     |
| `evidences[].file.hashes[]`          | `algorithm`, `algorithmId`, `value`                                                                                                               |
| `evidences[].user`                   | `uid`, `name`, `fullName`, `domain`, `emailAddr`                                                                                                  |
| `evidences[].srcEndpoint`            | `uid`, `hostname`, `ip`, `port`, `domain`                                                                                                         |
| `evidences[].dstEndpoint`            | `uid`, `hostname`, `ip`, `port`, `domain`                                                                                                         |
| `evidences[].url`                    | `urlString`, `scheme`, `hostname`, `port`, `path`, `queryString`                                                                                  |
| `osint[]`                            | `uid`, `name`, `type`, `typeId`, `value`, `category`, `confidence`, `confidenceId`, `riskScore`, `severity`, `severityId`, `references`, `srcUrl` |
| `remediation`                        | `kbArticles`, `references`, `s1QuarantinePath`                                                                                                    |
| `s1DlpFindingInfo`                   | `s1DlpIsUserNotified`, `s1DlpTransferChannel`, `s1DlpTransferChannelId`                                                                           |

The detail query also requests `id`, `updatedAt`, and `realTime.scope` account, site, and group IDs and names. These fields support identity and scope checks. They are outside `ocsf`.

GraphQL errors, a mismatched alert ID, a missing `ocsf` field, or an invalid `ocsf` value fail the request. A successful response with `ocsf: null` remains valid.

The envelope includes `ocsfAlertUpdatedAt`, copied from the detail response’s alert `updatedAt`. The detail request can observe a later alert version than the list query. The outer event timestamp remains the polled event timestamp; these requests do not form an atomic snapshot.
