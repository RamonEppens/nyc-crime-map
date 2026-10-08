
# NYPD Complaint Data Historic — data audit

Generated 2026-10-07 from 21 files, **10,071,507 rows**. Dataset snapshot (rowsUpdatedAt): 2026-04-28T16:10:09+00:00.

Descriptive only. Interpretation and decisions go in `docs/DATA_NOTES.md`.


## 1. Volume by report year

| report_year | rows | pct |
|---|---|---|
| 2006 | 530,891 | 5.27 |
| 2007 | 536,330 | 5.33 |
| 2008 | 529,973 | 5.26 |
| 2009 | 512,985 | 5.09 |
| 2010 | 509,731 | 5.06 |
| 2011 | 498,589 | 4.95 |
| 2012 | 504,351 | 5.01 |
| 2013 | 497,264 | 4.94 |
| 2014 | 491,332 | 4.88 |
| 2015 | 478,583 | 4.75 |
| 2016 | 478,934 | 4.76 |
| 2017 | 469,017 | 4.66 |
| 2018 | 464,138 | 4.61 |
| 2019 | 461,926 | 4.59 |
| 2020 | 413,639 | 4.11 |
| 2021 | 450,042 | 4.47 |
| 2022 | 531,996 | 5.28 |
| 2023 | 555,117 | 5.51 |
| 2024 | 577,108 | 5.73 |
| 2025 | 579,561 | 5.75 |


## 2. Complaint ID uniqueness

| rows | distinct_ids | duplicate_rows | null_ids |
|---|---|---|---|
| 10,071,507 | 10,070,401 | 1,106 | 0 |

| cmplnt_num | n |
|---|---|
| 10783181 | 2 |
| 10691883 | 2 |
| 11053977 | 2 |
| 10884719 | 2 |
| 10918461 | 2 |
| 10924330 | 2 |
| 24034571 | 2 |
| 10823677 | 2 |
| 10665852 | 2 |
| 11047403 | 2 |
| 10050969 | 2 |
| 10364342 | 2 |
| 10345304 | 2 |
| 10682860 | 2 |
| 11005739 | 2 |
| 10106702 | 2 |
| 24035324 | 2 |
| 10987682 | 2 |
| 10831890 | 2 |
| 10156715 | 2 |


## 3. Dates: occurrence vs report

| pct_no_report_date | pct_no_occurrence_date | pct_unparseable_occurrence | pct_with_end_date | pct_occurs_after_report |
|---|---|---|---|---|
| 0 | 0.007 | 0 | 81.38 | 0 |

Occurrence year vs report year (rows where they differ are late reports or bad dates):

| report_year | same_year | prev_year | older | before_1990 | no_occ_date |
|---|---|---|---|---|---|
| 2006 | 519,309 | 8,652 | 2,735 | 80 | 195 |
| 2007 | 525,115 | 8,613 | 2,512 | 43 | 90 |
| 2008 | 518,984 | 8,272 | 2,663 | 45 | 54 |
| 2009 | 502,711 | 7,977 | 2,249 | 33 | 48 |
| 2010 | 501,009 | 6,788 | 1,834 | 38 | 100 |
| 2011 | 489,353 | 7,253 | 1,943 | 20 | 40 |
| 2012 | 494,740 | 7,683 | 1,895 | 30 | 33 |
| 2013 | 487,100 | 8,370 | 1,759 | 21 | 35 |
| 2014 | 482,401 | 7,118 | 1,774 | 29 | 39 |
| 2015 | 468,578 | 7,976 | 2,008 | 36 | 21 |
| 2016 | 468,417 | 8,449 | 2,068 | 58 | 0 |
| 2017 | 458,248 | 8,378 | 2,391 | 94 | 0 |
| 2018 | 453,057 | 8,481 | 2,600 | 95 | 0 |
| 2019 | 451,200 | 8,304 | 2,422 | 69 | 0 |
| 2020 | 405,098 | 6,570 | 1,971 | 57 | 0 |
| 2021 | 440,137 | 7,337 | 2,568 | 73 | 0 |
| 2022 | 520,801 | 8,472 | 2,723 | 64 | 0 |
| 2023 | 543,331 | 9,038 | 2,748 | 78 | 0 |
| 2024 | 565,118 | 9,111 | 2,879 | 65 | 0 |
| 2025 | 567,668 | 9,074 | 2,819 | 44 | 0 |

Reporting lag (days from occurrence start to report), by offense level:

| law_cat_cd | n | p50_days | p90_days | p99_days |
|---|---|---|---|---|
| MISDEMEANOR | 5,515,683 | 0 | 5 | 166 |
| FELONY | 3,169,213 | 0 | 13 | 450 |
| VIOLATION | 1,385,956 | 0 | 4 | 133 |


## 4. Time of day

Heaping at round times (00:00, 12:00, on the hour) signals estimated or default times.

| pct_null | pct_midnight | pct_noon | pct_on_the_hour |
|---|---|---|---|
| 0 | 0.84 | 2.55 | 33.81 |

| hour | n |
|---|---|
| 0 | 473,260 |
| 1 | 330,953 |
| 2 | 270,098 |
| 3 | 228,515 |
| 4 | 198,919 |
| 5 | 146,082 |
| 6 | 153,889 |
| 7 | 220,569 |
| 8 | 348,824 |
| 9 | 380,288 |
| 10 | 402,642 |
| 11 | 413,431 |
| 12 | 562,633 |
| 13 | 481,842 |
| 14 | 539,916 |
| 15 | 606,745 |
| 16 | 587,513 |
| 17 | 591,574 |
| 18 | 597,671 |
| 19 | 572,060 |
| 20 | 560,216 |
| 21 | 504,374 |
| 22 | 471,553 |
| 23 | 427,892 |
|  | 48 |


## 5. Location

| pct_no_coords | pct_outside_nyc_bbox | pct_no_state_plane |
|---|---|---|
| 0 | 0 | 0 |

Share without coordinates, by report year:

| report_year | n | pct_no_coords |
|---|---|---|
| 2006 | 530,891 | 0.08 |
| 2007 | 536,330 | 0.01 |
| 2008 | 529,973 | 0 |
| 2009 | 512,985 | 0 |
| 2010 | 509,731 | 0 |
| 2011 | 498,589 | 0 |
| 2012 | 504,351 | 0 |
| 2013 | 497,264 | 0 |
| 2014 | 491,332 | 0 |
| 2015 | 478,583 | 0 |
| 2016 | 478,934 | 0 |
| 2017 | 469,017 | 0 |
| 2018 | 464,138 | 0 |
| 2019 | 461,926 | 0 |
| 2020 | 413,639 | 0 |
| 2021 | 450,042 | 0 |
| 2022 | 531,996 | 0 |
| 2023 | 555,117 | 0 |
| 2024 | 577,108 | 0 |
| 2025 | 579,561 | 0 |

Offenses with the highest share of missing coordinates (n ≥ 500):

| ofns_desc | n | pct_no_coords |
|---|---|---|
| MURDER & NON-NEGL. MANSLAUGHTER | 8,284 | 1.1 |
| GRAND LARCENY OF MOTOR VEHICLE | 201,767 | 0.1 |
| PETIT LARCENY | 1,772,206 | 0 |
| HARRASSMENT 2 | 1,359,235 | 0 |
| ASSAULT 3 & RELATED OFFENSES | 1,059,220 | 0 |
| CRIMINAL MISCHIEF & RELATED OF | 952,237 | 0 |
| GRAND LARCENY | 880,071 | 0 |
| DANGEROUS DRUGS | 490,641 | 0 |
| OFF. AGNST PUB ORD SENSBLTY & | 473,080 | 0 |
| FELONY ASSAULT | 423,210 | 0 |
| ROBBERY | 346,607 | 0 |
| BURGLARY | 323,118 | 0 |
| MISCELLANEOUS PENAL LAW | 272,553 | 0 |
| DANGEROUS WEAPONS | 200,150 | 0 |
| VEHICLE AND TRAFFIC LAWS | 186,564 | 0 |
| OFFENSES AGAINST PUBLIC ADMINI | 175,025 | 0 |
| SEX CRIMES | 131,879 | 0 |
| INTOXICATED & IMPAIRED DRIVING | 112,225 | 0 |
| FORGERY | 102,252 | 0 |
| CRIMINAL TRESPASS | 96,468 | 0 |
| THEFT-FRAUD | 93,551 | 0 |
| FRAUDS | 57,064 | 0 |
| POSSESSION OF STOLEN PROPERTY | 47,238 | 0 |
| OFFENSES INVOLVING FRAUD | 37,352 | 0 |
| RAPE | 30,078 | 0 |

**Coordinate stacking**: how many incidents share an identical point.

| distinct_points | located_incidents | pct_in_stacks_2plus | pct_in_stacks_16plus | pct_in_stacks_100plus | biggest_stack |
|---|---|---|---|---|---|
| 164,436 | 10,071,028 | 99.8 | 95.5 | 71.9 | 29,322 |

Largest stacks, with their dominant premise type (candidates for 'registration locations': precincts, hospitals, transit hubs, malls):

| lat | lon | n | boro | precinct | top_premise | pct_top_premise |
|---|---|---|---|---|---|---|
| 40.750423 | -73.98928 | 29,322 | MANHATTAN | 14 | DEPARTMENT STORE | 80 |
| 40.679701 | -73.776047 | 22,894 | QUEENS | 113 | AIRPORT TERMINAL | 70 |
| 40.733729 | -73.871197 | 13,396 | QUEENS | 110 | DEPARTMENT STORE | 54 |
| 40.804008 | -73.878333 | 12,833 | BRONX | 41 | OTHER | 90 |
| 40.650466 | -73.869986 | 9,867 | BROOKLYN | 75 | CHAIN STORE | 42 |
| 40.822622 | -73.930942 | 9,503 | BRONX | 44 | CHAIN STORE | 46 |
| 40.873944 | -73.908788 | 8,573 | BRONX | 52 | DEPARTMENT STORE | 48 |
| 40.756259 | -73.990501 | 8,161 | MANHATTAN | 14 | BUS TERMINAL | 63 |
| 40.684454 | -73.97775 | 7,962 | BROOKLYN | 78 | CHAIN STORE | 37 |
| 40.804376 | -73.93742 | 7,673 | MANHATTAN | 25 | TRANSIT - NYC SUBWAY | 72 |
| 40.789593 | -73.929984 | 7,425 | MANHATTAN | 25 | OTHER | 37 |
| 40.710086 | -74.010609 | 7,306 | MANHATTAN | 1 | DEPARTMENT STORE | 78 |
| 40.808372 | -73.946904 | 7,173 | MANHATTAN | 28 | DEPARTMENT STORE | 21 |
| 40.757232 | -73.989792 | 7,057 | MANHATTAN | 14 | TRANSIT - NYC SUBWAY | 79 |
| 40.67136 | -73.881811 | 6,358 | BROOKLYN | 75 | RESIDENCE - APT. HOUSE | 40 |
| 40.576157 | -73.975984 | 6,276 | BROOKLYN | 60 | PARK/PLAYGROUND | 28 |
| 40.852004 | -73.922496 | 6,107 | BRONX | 46 | RESIDENCE - APT. HOUSE | 74 |
| 40.864393 | -73.829709 | 6,076 | BRONX | 45 | DEPARTMENT STORE | 52 |
| 40.757691 | -73.834115 | 6,015 | QUEENS | 109 | DEPARTMENT STORE | 46 |
| 40.749113 | -73.986165 | 5,979 | MANHATTAN | 14 | CLOTHING/BOUTIQUE | 49 |
| 40.756635 | -73.98837 | 5,938 | MANHATTAN | 14 | STREET | 21 |
| 40.690859 | -73.985848 | 5,924 | BROOKLYN | 84 | DEPARTMENT STORE | 69 |
| 40.829956 | -73.936699 | 5,889 | MANHATTAN | 32 | RESIDENCE - PUBLIC HOUSING | 92 |
| 40.823102 | -73.86969 | 5,853 | BRONX | 43 | STREET | 69 |
| 40.683291 | -73.974852 | 5,844 | BROOKLYN | 78 | CHAIN STORE | 22 |
| 40.610931 | -73.920761 | 5,490 | BROOKLYN | 63 | DEPARTMENT STORE | 60 |
| 40.816067 | -73.917644 | 5,482 | BRONX | 40 | TRANSIT - NYC SUBWAY | 63 |
| 40.78845 | -73.939372 | 5,429 | MANHATTAN | 23 | RESIDENCE - PUBLIC HOUSING | 97 |
| 40.756568 | -73.875932 | 5,417 | QUEENS | 115 | RESIDENCE - APT. HOUSE | 31 |
| 40.759861 | -73.828967 | 5,374 | QUEENS | 109 | DEPARTMENT STORE | 52 |
| 40.734434 | -73.989904 | 5,343 | MANHATTAN | 13 | TRANSIT - NYC SUBWAY | 85 |
| 40.756861 | -73.875656 | 5,323 | QUEENS | 115 | AIRPORT TERMINAL | 61 |
| 40.83089 | -73.827284 | 5,059 | BRONX | 45 | STREET | 50 |
| 40.671107 | -73.881433 | 5,024 | BROOKLYN | 75 | STREET | 72 |
| 40.734955 | -73.874983 | 4,989 | QUEENS | 110 | DEPARTMENT STORE | 78 |
| 40.582305 | -74.169067 | 4,928 | STATEN ISLAND | 122 | DEPARTMENT STORE | 25 |
| 40.753533 | -73.994537 | 4,926 | MANHATTAN | 14 | TRANSIT - NYC SUBWAY | 40 |
| 40.761865 | -73.966355 | 4,809 | MANHATTAN | 19 | DEPARTMENT STORE | 56 |
| 40.735027 | -73.991235 | 4,750 | MANHATTAN | 6 | CHAIN STORE | 28 |
| 40.837323 | -73.919831 | 4,674 | BRONX | 44 | STREET | 68 |


## 6. Borough and precinct fields

| boro_nm | n | pct |
|---|---|---|
| BROOKLYN | 2,940,167 | 29.19 |
| MANHATTAN | 2,424,880 | 24.08 |
| BRONX | 2,184,541 | 21.69 |
| QUEENS | 2,053,345 | 20.39 |
| STATEN ISLAND | 458,496 | 4.55 |
| (null) | 10,078 | 0.1 |

| distinct_precincts | pct_null_precinct |
|---|---|
| 78 | 0.008 |

| juris_desc | n | pct |
|---|---|---|
| N.Y. POLICE DEPT | 8,955,346 | 88.92 |
| N.Y. HOUSING POLICE | 734,223 | 7.29 |
| N.Y. TRANSIT POLICE | 260,463 | 2.59 |
| PORT AUTHORITY | 45,364 | 0.45 |
| OTHER | 28,373 | 0.28 |
| DEPT OF CORRECTIONS | 12,359 | 0.12 |
| POLICE DEPT NYC | 8,955 | 0.09 |
| TRI-BORO BRDG TUNNL | 6,212 | 0.06 |
| MTA POLICE DEPT | 4,533 | 0.05 |
| HEALTH & HOSP CORP | 4,421 | 0.04 |
| N.Y. STATE POLICE | 2,902 | 0.03 |
| NYC PARKS | 2,023 | 0.02 |
| METRO NORTH | 1,207 | 0.01 |
| AMTRACK | 733 | 0.01 |
| LONG ISLAND RAILRD | 606 | 0.01 |
| NEW YORK CITY SHERIFF OFFICE | 604 | 0.01 |
| N.Y.C. DEPT OF HOMELESS SERVICES | 567 | 0.01 |
| N.Y. STATE PARKS | 555 | 0.01 |
| DISTRICT ATTORNEY OFFICE | 523 | 0.01 |
| FIRE DEPT (FIRE MARSHAL) | 477 | 0 |
| STATN IS RAPID TRANS | 465 | 0 |
| U.S. PARK POLICE | 339 | 0 |
| NYS DEPT TAX AND FINANCE | 125 | 0 |
| N.Y.C. DEPT OF PROBATION | 58 | 0 |
| SEA GATE POLICE DEPT | 30 | 0 |
| NYC DEPT ENVIRONMENTAL PROTECTION | 24 | 0 |
| CONRAIL | 19 | 0 |
| NYS DEPT ENVIRONMENTAL CONSERVATION | 1 | 0 |


## 7. Offense classification

| ky_codes | ofns_descs | pd_codes | pd_descs |
|---|---|---|---|
| 75 | 75 | 443 | 434 |

Key codes with more than one description (labels that changed over time):

| ky_cd | n_labels | labels |
|---|---|---|
| 125 | 5 | NYS LAWS-UNCLASSIFIED FELONY / OTHER STATE LAWS (NON PENAL LA / (null) / VEHICLE AND TRAFFIC LAWS / OTHER STATE LAWS |
| 364 | 4 | OTHER STATE LAWS (NON PENAL LA / AGRICULTURE & MRKTS LAW-UNCLASSIFIED / OTHER STATE LAWS (NON PENAL LAW) / (null) |
| 343 | 4 | OTHER OFFENSES RELATED TO THEF / THEFT OF SERVICES / (null) / OTHER OFFENSES RELATED TO THEFT |
| 124 | 4 | (null) / KIDNAPPING AND RELATED OFFENSES / KIDNAPPING & RELATED OFFENSES / KIDNAPPING |
| 120 | 3 | CHILD ABANDONMENT/NON SUPPORT 1 / ENDAN WELFARE INCOMP / CHILD ABANDONMENT/NON SUPPORT |
| 116 | 3 | (null) / FELONY SEX CRIMES / SEX CRIMES |
| 109 | 2 | GRAND LARCENY / (null) |
| 358 | 2 | OFFENSES INVOLVING FRAUD / (null) |
| 344 | 2 | (null) / ASSAULT 3 & RELATED OFFENSES |
| 341 | 2 | (null) / PETIT LARCENY |
| 366 | 2 | (null) / NEW YORK CITY HEALTH CODE |
| 356 | 2 | PROSTITUTION & RELATED OFFENSES / (null) |
| 360 | 2 | (null) / LOITERING FOR DRUG PURPOSES |
| 112 | 2 | (null) / THEFT-FRAUD |
| 361 | 2 | (null) / OFF. AGNST PUB ORD SENSBLTY & |
| 340 | 2 | FRAUDS / (null) |
| 236 | 2 | (null) / DANGEROUS WEAPONS |
| 677 | 2 | NYS LAWS-UNCLASSIFIED VIOLATION / OTHER STATE LAWS |
| 237 | 2 | ESCAPE 3 / (null) |
| 351 | 2 | CRIMINAL MISCHIEF & RELATED OF / (null) |
| 107 | 2 | BURGLARY / (null) |
| 233 | 2 | SEX CRIMES / (null) |
| 126 | 2 | (null) / MISCELLANEOUS PENAL LAW |
| 675 | 2 | (null) / ADMINISTRATIVE CODE |
| 678 | 2 | (null) / MISCELLANEOUS PENAL LAW |
| 355 | 2 | (null) / OFFENSES AGAINST THE PERSON |
| 106 | 2 | (null) / FELONY ASSAULT |
| 111 | 2 | (null) / POSSESSION OF STOLEN PROPERTY |
| 230 | 2 | JOSTLING / (null) |
| 105 | 2 | ROBBERY / (null) |
| 117 | 2 | DANGEROUS DRUGS / (null) |
| 365 | 2 | (null) / ADMINISTRATIVE CODE |
| 235 | 2 | DANGEROUS DRUGS / (null) |
| 347 | 2 | (null) / INTOXICATED & IMPAIRED DRIVING |
| 359 | 2 | OFFENSES AGAINST PUBLIC ADMINI / (null) |
| 121 | 2 | CRIMINAL MISCHIEF & RELATED OF / (null) |
| 350 | 2 | (null) / GAMBLING |
| 348 | 2 | VEHICLE AND TRAFFIC LAWS / (null) |
| 363 | 2 | OFFENSES AGAINST PUBLIC SAFETY / (null) |
| 232 | 2 | POSSESSION OF STOLEN PROPERTY / (null) |
| 345 | 2 | ENDAN WELFARE INCOMP / OFFENSES RELATED TO CHILDREN |
| 352 | 2 | CRIMINAL TRESPASS / (null) |
| 578 | 2 | HARRASSMENT 2 / (null) |

| law_cat_cd | n | pct |
|---|---|---|
| MISDEMEANOR | 5,516,027 | 54.77 |
| FELONY | 3,169,433 | 31.47 |
| VIOLATION | 1,386,047 | 13.76 |

| completed_or_attempted | n |
|---|---|
| COMPLETED | 9,907,842 |
| ATTEMPTED | 163,497 |
| (null) | 168 |

Top 40 offense descriptions, counts by report year (watch for categories that appear/disappear):

| ofns_desc | total | 2006 | 2007 | 2008 | 2009 | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PETIT LARCENY | 1,772,206 | 80,379 | 80,016 | 83,096 | 80,912 | 81,317 | 81,079 | 82,855 | 85,515 | 84,998 | 81,522 | 81,201 | 83,496 | 86,364 | 89,187 | 82,008 | 87,290 | 115,630 | 110,081 | 109,799 | 105,461 |
| HARRASSMENT 2 | 1,359,235 | 68,615 | 65,155 | 61,141 | 58,579 | 57,344 | 54,232 | 57,038 | 57,617 | 61,953 | 62,136 | 65,956 | 66,544 | 70,417 | 72,022 | 66,799 | 74,827 | 83,017 | 83,954 | 85,634 | 86,255 |
| ASSAULT 3 & RELATED OFFENSES | 1,059,220 | 51,570 | 51,124 | 50,294 | 50,199 | 52,609 | 50,874 | 54,436 | 53,635 | 53,736 | 52,182 | 52,410 | 51,436 | 53,106 | 52,739 | 43,381 | 48,331 | 54,946 | 58,322 | 62,992 | 60,898 |
| CRIMINAL MISCHIEF & RELATED OF | 952,237 | 52,966 | 55,863 | 56,057 | 52,126 | 50,878 | 49,314 | 47,738 | 44,177 | 47,198 | 48,829 | 48,831 | 49,311 | 47,214 | 47,148 | 47,233 | 44,735 | 44,711 | 42,339 | 39,600 | 35,969 |
| GRAND LARCENY | 880,071 | 46,565 | 44,832 | 44,219 | 39,627 | 38,116 | 38,816 | 42,853 | 45,607 | 44,186 | 44,242 | 44,493 | 43,384 | 43,777 | 43,533 | 35,738 | 41,197 | 51,820 | 50,514 | 48,445 | 48,107 |
| DANGEROUS DRUGS | 490,641 | 33,565 | 39,871 | 38,642 | 39,627 | 38,919 | 38,469 | 34,675 | 29,435 | 28,800 | 23,685 | 22,650 | 21,866 | 15,197 | 13,430 | 8,221 | 7,750 | 8,672 | 13,076 | 15,280 | 18,811 |
| OFF. AGNST PUB ORD SENSBLTY & | 473,080 | 33,824 | 33,291 | 31,287 | 31,006 | 30,278 | 28,065 | 27,382 | 27,152 | 19,883 | 20,787 | 22,755 | 21,833 | 20,673 | 19,351 | 15,580 | 17,266 | 18,549 | 17,967 | 18,254 | 17,897 |
| FELONY ASSAULT | 423,210 | 17,036 | 17,322 | 16,282 | 16,774 | 17,064 | 18,605 | 19,504 | 20,388 | 20,279 | 20,381 | 20,923 | 20,185 | 20,385 | 20,898 | 20,779 | 23,066 | 26,201 | 27,845 | 29,452 | 29,841 |
| ROBBERY | 346,607 | 22,961 | 21,417 | 22,406 | 18,613 | 19,547 | 19,766 | 20,192 | 19,172 | 16,569 | 16,971 | 15,533 | 14,000 | 12,966 | 13,452 | 13,160 | 13,871 | 17,440 | 16,905 | 16,574 | 15,092 |
| BURGLARY | 323,118 | 23,072 | 21,686 | 20,728 | 19,444 | 18,699 | 18,834 | 19,262 | 17,509 | 16,845 | 15,184 | 13,043 | 12,151 | 11,784 | 10,919 | 15,600 | 12,883 | 15,825 | 13,757 | 13,067 | 12,826 |
| MISCELLANEOUS PENAL LAW | 272,553 | 9,923 | 10,582 | 11,136 | 11,626 | 11,393 | 11,426 | 12,042 | 13,119 | 13,701 | 13,461 | 13,878 | 13,279 | 13,225 | 14,261 | 12,708 | 14,474 | 15,806 | 17,527 | 19,035 | 19,951 |
| GRAND LARCENY OF MOTOR VEHICLE | 201,767 | 15,914 | 13,155 | 12,473 | 10,661 | 10,302 | 9,292 | 8,067 | 7,377 | 7,650 | 7,325 | 6,319 | 5,660 | 5,426 | 5,420 | 9,055 | 10,409 | 13,740 | 15,797 | 14,193 | 13,532 |
| DANGEROUS WEAPONS | 200,150 | 10,462 | 12,681 | 12,902 | 14,309 | 14,129 | 13,639 | 12,112 | 11,677 | 10,767 | 10,528 | 10,469 | 8,685 | 7,889 | 6,298 | 4,896 | 5,440 | 6,811 | 8,173 | 9,157 | 9,126 |
| VEHICLE AND TRAFFIC LAWS | 186,564 | 5,823 | 5,520 | 5,233 | 6,176 | 6,616 | 5,812 | 5,575 | 6,101 | 5,837 | 6,274 | 6,581 | 6,460 | 6,717 | 6,782 | 6,320 | 8,380 | 13,326 | 22,934 | 24,599 | 25,498 |
| OFFENSES AGAINST PUBLIC ADMINI | 175,025 | 5,431 | 9,609 | 10,361 | 11,209 | 11,120 | 11,062 | 10,721 | 10,700 | 10,296 | 9,395 | 8,930 | 8,000 | 7,524 | 7,624 | 5,477 | 5,730 | 6,517 | 7,181 | 8,510 | 9,628 |
| SEX CRIMES | 131,879 | 5,797 | 5,370 | 5,186 | 5,373 | 5,525 | 5,634 | 5,829 | 5,108 | 5,334 | 5,697 | 6,271 | 6,799 | 7,412 | 7,312 | 5,358 | 7,057 | 8,017 | 9,188 | 9,682 | 9,930 |
| INTOXICATED & IMPAIRED DRIVING | 112,225 | 6,952 | 8,640 | 8,264 | 7,692 | 6,690 | 6,028 | 6,723 | 8,239 | 7,875 | 5,933 | 5,965 | 5,651 | 4,981 | 4,366 | 2,379 | 2,577 | 2,869 | 3,382 | 3,251 | 3,768 |
| FORGERY | 102,252 | 6,382 | 5,999 | 5,081 | 4,734 | 4,769 | 3,994 | 3,811 | 4,165 | 4,713 | 5,224 | 6,290 | 5,457 | 5,208 | 4,812 | 2,108 | 4,529 | 5,716 | 5,638 | 7,042 | 6,580 |
| CRIMINAL TRESPASS | 96,468 | 6,441 | 8,033 | 8,311 | 8,565 | 7,714 | 6,826 | 5,811 | 4,987 | 5,147 | 4,327 | 3,924 | 3,598 | 3,259 | 3,041 | 2,113 | 1,912 | 2,275 | 2,458 | 3,564 | 4,162 |
| THEFT-FRAUD | 93,551 | 5,770 | 6,044 | 7,122 | 5,486 | 5,172 | 5,744 | 6,376 | 5,233 | 4,707 | 5,073 | 4,698 | 4,520 | 4,146 | 3,804 | 2,561 | 3,761 | 3,242 | 4,280 | 2,764 | 3,048 |
| FRAUDS | 57,064 | 2,637 | 2,575 | 3,073 | 3,093 | 3,112 | 3,182 | 3,579 | 3,376 | 3,797 | 3,578 | 3,376 | 2,832 | 2,591 | 2,161 | 1,452 | 2,571 | 1,906 | 2,834 | 2,429 | 2,910 |
| POSSESSION OF STOLEN PROPERTY | 47,238 | 3,049 | 2,920 | 2,826 | 2,841 | 3,087 | 3,662 | 3,365 | 3,009 | 2,521 | 2,036 | 1,683 | 1,957 | 1,752 | 1,379 | 1,136 | 1,185 | 1,630 | 2,492 | 2,600 | 2,108 |
| OFFENSES INVOLVING FRAUD | 37,352 | 1,901 | 1,797 | 1,714 | 2,059 | 2,289 | 1,972 | 1,668 | 1,529 | 1,525 | 1,176 | 1,241 | 1,161 | 1,158 | 984 | 901 | 2,563 | 3,122 | 3,392 | 3,038 | 2,162 |
| RAPE | 30,078 | 1,504 | 1,343 | 1,299 | 1,207 | 1,365 | 1,410 | 1,458 | 1,380 | 1,361 | 1,436 | 1,450 | 1,477 | 1,807 | 1,763 | 1,444 | 1,496 | 1,628 | 1,452 | 1,749 | 2,049 |
| OTHER OFFENSES RELATED TO THEFT | 29,534 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13,164 | 16,370 |
| UNAUTHORIZED USE OF A VEHICLE | 29,332 | 1,315 | 1,308 | 1,169 | 1,186 | 1,295 | 1,305 | 1,419 | 1,511 | 1,721 | 1,605 | 1,809 | 1,673 | 1,633 | 1,615 | 1,481 | 1,292 | 1,431 | 1,691 | 1,591 | 1,282 |
| ADMINISTRATIVE CODE | 27,161 | 1,147 | 1,101 | 1,149 | 1,243 | 1,127 | 1,153 | 1,145 | 1,126 | 1,097 | 1,075 | 999 | 887 | 1,021 | 1,099 | 923 | 776 | 1,156 | 1,712 | 2,388 | 4,837 |
| OFFENSES AGAINST THE PERSON | 25,455 | 1,111 | 1,283 | 1,149 | 1,125 | 1,199 | 1,202 | 1,243 | 1,370 | 1,334 | 1,289 | 1,230 | 1,349 | 1,149 | 1,261 | 873 | 1,041 | 1,166 | 1,526 | 1,831 | 1,724 |
| ARSON | 20,652 | 1,620 | 1,586 | 1,814 | 1,492 | 1,485 | 1,247 | 1,243 | 1,203 | 1,191 | 1,042 | 783 | 689 | 735 | 706 | 832 | 634 | 650 | 637 | 621 | 442 |
| OTHER OFFENSES RELATED TO THEF | 20,122 | 485 | 651 | 754 | 885 | 964 | 918 | 1,067 | 1,133 | 1,347 | 1,519 | 1,728 | 1,511 | 1,378 | 1,285 | 627 | 626 | 714 | 2,530 | 0 | 0 |
| (null) | 18,907 | 3,611 | 2,113 | 1,715 | 1,765 | 1,999 | 1,631 | 1,641 | 1,580 | 1,502 | 1,186 | 54 | 23 | 10 | 15 | 6 | 10 | 8 | 17 | 8 | 13 |
| NYS LAWS-UNCLASSIFIED FELONY | 9,450 | 315 | 391 | 400 | 433 | 364 | 294 | 304 | 315 | 422 | 490 | 688 | 658 | 696 | 697 | 449 | 365 | 721 | 1,448 | 0 | 0 |
| MURDER & NON-NEGL. MANSLAUGHTER | 8,284 | 596 | 496 | 523 | 471 | 535 | 514 | 419 | 335 | 333 | 352 | 335 | 292 | 295 | 319 | 468 | 486 | 438 | 386 | 382 | 309 |
| OTHER STATE LAWS (NON PENAL LA | 8,254 | 641 | 768 | 522 | 594 | 577 | 577 | 423 | 390 | 553 | 424 | 242 | 329 | 305 | 246 | 265 | 293 | 473 | 632 | 0 | 0 |
| OTHER STATE LAWS | 7,335 | 21 | 42 | 20 | 22 | 40 | 18 | 20 | 14 | 19 | 12 | 19 | 12 | 12 | 11 | 10 | 8 | 83 | 192 | 2,419 | 4,341 |
| BURGLAR'S TOOLS | 5,859 | 150 | 191 | 172 | 218 | 222 | 271 | 290 | 290 | 375 | 286 | 263 | 259 | 325 | 308 | 230 | 216 | 349 | 440 | 498 | 506 |
| THEFT OF SERVICES | 5,068 | 0 | 11 | 32 | 40 | 321 | 303 | 588 | 570 | 444 | 469 | 486 | 345 | 378 | 430 | 109 | 130 | 178 | 234 | 0 | 0 |
| GAMBLING | 4,226 | 171 | 236 | 200 | 204 | 191 | 152 | 190 | 132 | 184 | 343 | 268 | 246 | 151 | 280 | 113 | 123 | 164 | 212 | 232 | 434 |
| FRAUDULENT ACCOSTING | 3,754 | 285 | 239 | 298 | 309 | 310 | 295 | 291 | 192 | 242 | 178 | 212 | 187 | 200 | 156 | 48 | 42 | 71 | 51 | 47 | 101 |
| PETIT LARCENY OF MOTOR VEHICLE | 3,584 | 179 | 126 | 106 | 77 | 58 | 67 | 67 | 80 | 78 | 71 | 42 | 54 | 83 | 85 | 163 | 143 | 163 | 353 | 643 | 946 |


## 8. Completeness of every column

Null = missing; placeholder = literal values like '(null)' or 'UNKNOWN'. Demographic columns are listed for completeness only.

| column_name | pct_null | pct_placeholder | distinct_values |
|---|---|---|---|
| transit_district | 97.42 | 0 | 12 |
| cmplnt_to_dt | 18.62 | 0 | 8,824 |
| housing_psa | 5.38 | 87.26 | 4,849 |
| pd_cd | 0.08 | 0 | 443 |
| addr_pct_cd | 0.01 | 0 | 78 |
| cmplnt_fr_dt | 0.01 | 0 | 10,805 |
| hadevelopt | 0 | 99.65 | 39 |
| parks_nm | 0 | 99.56 | 1,310 |
| station_name | 0 | 97.42 | 373 |
| susp_age_group | 0 | 63.64 | 293 |
| susp_race | 0 | 54.97 | 9 |
| susp_sex | 0 | 39.17 | 4 |
| vic_race | 0 | 32.79 | 9 |
| vic_age_group | 0 | 31.14 | 292 |
| loc_of_occur_desc | 0 | 20.65 | 6 |
| cmplnt_to_tm | 0 | 18.55 | 1,441 |
| prem_typ_desc | 0 | 0.54 | 95 |
| ofns_desc | 0 | 0.19 | 75 |
| boro_nm | 0 | 0.1 | 6 |
| pd_desc | 0 | 0.08 | 434 |
| patrol_boro | 0 | 0.01 | 9 |
| jurisdiction_code | 0 | 0 | 28 |
| y_coord_cd | 0 | 0 | 73,496 |
| x_coord_cd | 0 | 0 | 70,909 |
| cmplnt_num | 0 | 0 | 10,070,401 |
| juris_desc | 0 | 0 | 28 |
| law_cat_cd | 0 | 0 | 3 |
| latitude | 0 | 0 | 168,410 |
| longitude | 0 | 0 | 171,282 |
| crm_atpt_cptd_cd | 0 | 0 | 3 |
| ky_cd | 0 | 0 | 75 |
| rpt_dt | 0 | 0 | 7,305 |
| cmplnt_fr_tm | 0 | 0 | 1,442 |
| vic_sex | 0 | 0 | 7 |


_34 columns audited; 6 demographic columns not broken down._
